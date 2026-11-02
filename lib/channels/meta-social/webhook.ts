/**
 * Webhook do canal social oficial (Instagram e Messenger) — verificação e
 * leitura. PURO: nada aqui toca banco nem rede.
 *
 * Um endereço para a instalação inteira (`/api/v1/webhooks/meta-social`), não
 * por sessão: a Meta assina com o segredo do app, e a organização sai da
 * sessão encontrada por `(plataforma pelo object, entry.id)` — nunca de campo
 * nenhum do corpo que diga "organização". O índice único da 0984 garante que a
 * mesma conta não está ativa em duas organizações.
 */
import { z } from "zod";

import { verifyMetaSignature } from "@/lib/channels/meta/webhook";
import type { PlataformaMetaSocial } from "./constantes";

/**
 * A assinatura confere com QUALQUER um dos segredos da instalação. Todos são
 * conferidos (sem atalho), para o tempo de resposta não dizer qual bateu.
 */
export function assinaturaMetaSocialConfere(
  rawBody: string,
  header: string | null,
  segredos: readonly string[],
): boolean {
  let confere = false;
  for (const s of segredos) {
    if (s && verifyMetaSignature(rawBody, header, s)) confere = true;
  }
  return confere;
}

export function plataformaDoObjeto(object: unknown): PlataformaMetaSocial | null {
  if (object === "instagram") return "instagram";
  if (object === "page") return "messenger";
  return null;
}

export interface AnexoMetaSocial {
  type: string;
  url: string;
}

export type EventoMetaSocial =
  | {
      tipo: "mensagem";
      plataforma: PlataformaMetaSocial;
      /** `entry.id`: a NOSSA conta (IG ou Página). */
      contaId: string;
      /** IGSID/PSID do cliente. */
      clienteId: string;
      mid: string;
      direcao: "inbound" | "outbound";
      texto: string | null;
      anexos: AnexoMetaSocial[];
      enviadaEm: string | null;
      /** `message.app_id` do eco, quando a Meta manda: quem enviou pela API. */
      appId: string | null;
    }
  | {
      tipo: "apagada";
      plataforma: PlataformaMetaSocial;
      contaId: string;
      mid: string;
    }
  | {
      /**
       * O cliente leu. Instagram (`messaging_seen`) diz QUAL mensagem (`mid`);
       * Messenger (`message_reads`) diz ATÉ QUANDO (`watermark`, ms): tudo o que
       * a Página enviou antes disso está lido.
       */
      tipo: "lida";
      plataforma: PlataformaMetaSocial;
      contaId: string;
      clienteId: string;
      mid: string | null;
      ateMs: number | null;
      lidaEm: string | null;
    };

const id = z.union([z.string().min(1), z.number()]).transform(String);
const itemDeMensagem = z
  .object({
    sender: z.object({ id }).loose().optional(),
    recipient: z.object({ id }).loose().optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
    read: z
      .object({
        mid: z.string().min(1).optional(),
        watermark: z.union([z.number(), z.string()]).optional(),
      })
      .loose()
      .optional(),
    message: z
      .object({
        mid: z.string().min(1),
        text: z.string().optional(),
        is_echo: z.boolean().optional(),
        is_deleted: z.boolean().optional(),
        app_id: z.union([z.string(), z.number()]).optional(),
        attachments: z
          .array(
            z
              .object({
                type: z.string(),
                payload: z.object({ url: z.string().optional() }).loose().nullish(),
              })
              .loose(),
          )
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export const envelopeMetaSocial = z
  .object({
    object: z.string(),
    entry: z
      .array(
        z
          .object({
            // Opcional no SCHEMA para uma entrada sem id não derrubar o envelope
            // inteiro (as outras entradas seguem); a leitura pula a que não tem.
            id: id.optional(),
            messaging: z.array(z.unknown()).optional(),
            changes: z.array(z.unknown()).optional(),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

export type EnvelopeMetaSocial = z.infer<typeof envelopeMetaSocial>;

/** Tipo do anexo da Meta → o vocabulário que a ingestão social já entende. */
function tipoDoAnexo(tipo: string): string | null {
  switch (tipo) {
    case "image":
    case "audio":
    case "video":
      return tipo;
    case "ig_reel":
    case "reel":
      return "video";
    case "file":
      return "file";
    default:
      return null;
  }
}

function dataDoTimestamp(t: unknown): string | null {
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A Messenger Platform manda MILISSEGUNDOS; segundos caberiam em 1970.
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/**
 * Extrai os eventos que interessam: mensagem, mensagem apagada e leitura.
 * Reação e postback são IGNORADOS (não viram erro): a Meta reentrega o que não
 * recebe 2xx.
 */
export function lerEventosMetaSocial(envelope: EnvelopeMetaSocial): EventoMetaSocial[] {
  const plataforma = plataformaDoObjeto(envelope.object);
  if (!plataforma) return [];
  const out: EventoMetaSocial[] = [];
  for (const entry of envelope.entry) {
    const contaId = entry.id;
    // Sem `entry.id` não há conta, e sem conta não há organização: ignorado.
    if (!contaId) continue;
    // `messaging[]` é o formato normal; o "Testar" do painel manda `changes[]`
    // com `field: "messages"` e o mesmo item em `value`.
    const itens: unknown[] = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? []).flatMap((c) => {
        const o = c as { field?: unknown; value?: unknown };
        return o && o.field === "messages" && o.value ? [o.value] : [];
      }),
    ];
    for (const bruto of itens) {
      const lido = itemDeMensagem.safeParse(bruto);
      if (!lido.success) continue;
      if (!lido.data.message) {
        // Leitura: quem leu é o cliente (sender), e quem recebe é a conta.
        const r = lido.data.read;
        const clienteId = lido.data.sender?.id;
        if (!r || lido.data.recipient?.id !== contaId || !clienteId || clienteId === contaId) continue;
        const marca = r.watermark !== undefined ? Number(r.watermark) : Number.NaN;
        const ateMs = Number.isFinite(marca) && marca > 0 ? (marca < 1e12 ? marca * 1000 : marca) : null;
        if (!r.mid && ateMs === null) continue;
        out.push({
          tipo: "lida",
          plataforma,
          contaId,
          clienteId,
          mid: r.mid ?? null,
          ateMs,
          lidaEm: dataDoTimestamp(lido.data.timestamp),
        });
        continue;
      }
      const m = lido.data.message;
      if (m.is_deleted) {
        out.push({ tipo: "apagada", plataforma, contaId, mid: m.mid });
        continue;
      }
      const eco = m.is_echo === true;
      const remetente = lido.data.sender?.id;
      const destinatario = lido.data.recipient?.id;
      // No eco, quem envia é a própria conta; na entrada, quem recebe. Item que
      // não fecha com o `entry.id` não é desta conta — não vira linha.
      if (eco ? remetente !== contaId : destinatario !== contaId) continue;
      const clienteId = eco ? destinatario : remetente;
      if (!clienteId || clienteId === contaId) continue;

      const anexos: AnexoMetaSocial[] = [];
      for (const a of m.attachments ?? []) {
        const t = tipoDoAnexo(a.type);
        const url = a.payload?.url;
        if (t && url && /^https:\/\//.test(url)) anexos.push({ type: t, url });
      }
      const semNada = !m.text && anexos.length === 0;
      out.push({
        tipo: "mensagem",
        plataforma,
        contaId,
        clienteId,
        mid: m.mid,
        direcao: eco ? "outbound" : "inbound",
        texto: m.text ?? (semNada && m.attachments?.[0] ? `[${m.attachments[0].type}]` : null),
        anexos,
        enviadaEm: dataDoTimestamp(lido.data.timestamp),
        appId: m.app_id !== undefined ? String(m.app_id) : null,
      });
    }
  }
  return out;
}
