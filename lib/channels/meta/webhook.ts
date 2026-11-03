/**
 * Webhook da Meta (Cloud API) — verificação e parse. **Puro e síncrono**: nada
 * aqui toca banco nem rede, para que cada regra seja testável sem ambiente.
 *
 * Duas diferenças em relação ao webhook do WAHA (`lib/waha/ingest.ts`), e as duas
 * já morderam quem tentou reaproveitar o outro:
 *
 *   1. **HMAC SHA-256, não SHA-512**, e o header vem prefixado: `X-Hub-Signature-256:
 *      sha256=<hex>`. Comparar sem tirar o prefixo reprova sempre.
 *   2. **A chave é o App Secret**, não um segredo por sessão. Um App Secret vale para
 *      todas as WABAs do app — por isso a rota ainda usa token no path, para amarrar
 *      o payload a UMA organização antes de confiar nele.
 *
 * `hub.challenge` (GET) faz parte do protocolo: a Meta só passa a entregar eventos
 * depois que o endpoint devolve o desafio **em texto puro** — não JSON, não
 * `{data:...}`. Envelopar quebra a verificação com uma mensagem inútil no dashboard.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { parseMetaInboundContact } from "@/lib/channels/meta/contact-card";
import type { SharedContact } from "@/lib/messaging/contact-card";
import type { MetaWebhookEnvelope } from "./envelope";

/** Assinatura da Meta: `sha256=<hex>` no header `X-Hub-Signature-256`. */
/**
 * A instalação consegue RECEBER pelo canal oficial? — as duas metades.
 *
 * São dois segredos com papéis diferentes, e conferir só um produz o pior tipo
 * de tela: a que diz "pronto" sobre algo que não funciona.
 *
 *   META_WEBHOOK_VERIFY_TOKEN → responde o handshake GET, em que a Meta valida
 *                               o endereço. Sem ele o webhook nem é aceito.
 *   META_APP_SECRET           → valida a ASSINATURA de cada mensagem que chega
 *                               (`verifyMetaSignature`, logo abaixo). Sem ele,
 *                               o handshake passa e TODO POST assinado morre em
 *                               401 `invalid_signature` — o número envia e
 *                               nunca recebe, sem erro em lugar nenhum.
 *
 * Nenhum dos dois é escrito pelo `install.sh` (`git grep 'META_' -- '*.sh'`
 * devolve vazio): numa instalação recém-feita os dois estão ausentes, que é
 * exatamente quando o aviso precisa aparecer.
 *
 * `.trim() !== ""` e não `Boolean()`: o contrato do `.env` deste projeto é que
 * vazio é ausente — o template gera `CHAVE=` e é assim que `preenchida()` em
 * `lib/instalacao/ambiente.ts:61` já decide.
 */
// O mesmo tipo que `lib/instalacao/ambiente.ts` usa para ler `.env`:
// `NodeJS.ProcessEnv` exige `NODE_ENV` e obrigaria todo teste a montá-lo.
export function metaPodeReceber(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const cheia = (nome: string): boolean => (source[nome] ?? "").trim() !== "";
  return cheia("META_WEBHOOK_VERIFY_TOKEN") && cheia("META_APP_SECRET");
}

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [algo, received] = signatureHeader.split("=");
  if (algo !== "sha256" || !received) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  // timingSafeEqual estoura se os tamanhos diferem — comparar antes evita
  // transformar assinatura malformada em exceção 500.
  if (received.length !== expected.length) return false;
  // Hex de verdade: `Buffer.from("zz…", "hex")` devolve um buffer MENOR (corta no primeiro
  // par inválido) e `timingSafeEqual` lança RangeError, que virava 500 em vez de 401.
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

/** Resposta do handshake de verificação (GET). `null` = recusar com 403. */
export function verificationChallenge(
  params: URLSearchParams,
  expectedVerifyToken: string,
): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!expectedVerifyToken) return null;
  if (params.get("hub.verify_token") !== expectedVerifyToken) return null;
  return params.get("hub.challenge");
}

/** Um template mudou de estado na Meta — o evento que a Fase 3a persegue. */
export interface TemplateStatusEvent {
  kind: "template_status";
  wabaId: string;
  templateName: string;
  templateLanguage: string;
  event: string;
  reason: string | null;
}

/**
 * Mensagem ENVIADA PELO CONTATO. A metade que faltava do canal: sem ela o oficial
 * é um megafone — o cliente responde e nada chega, nenhum lead se move, o agente não
 * acorda, e a janela de 24h (que deriva de `last_inbound_at`) nunca abre.
 */
export interface InboundMessageEvent {
  kind: "inbound_message";
  wabaId: string;
  /** Qual número NOSSO recebeu — é o que amarra a mensagem à sessão certa. */
  phoneNumberId: string;
  /** `wamid` — a chave de idempotência. A Meta re-entrega o que não recebe 2xx. */
  externalId: string;
  /**
   * `wa_id` do contato. **Pode vir sem o nono dígito** em celular brasileiro
   * (medido: 553191110001 para quem recebemos como 5531991110001), quem resolve o
   * contato TEM de usar `phoneLookupVariants`, senão duplica a pessoa.
   */
  from: string;
  profileName: string | null;
  sentAt: Date;
  /** `text` | `audio` | `image` | `video` | `document` | `sticker` | `contact` | … */
  type: string;
  text: string | null;
  /** Preenchido quando `type === "contact"` (cartão compartilhado). */
  sharedContact?: SharedContact | null;
  /** Opção escolhida num botão ou lista. Ver `RespostaDeOpcao`. */
  reply?: RespostaDeOpcao | null;
  /** Tipo cru da Meta, quando difere do gravado (`button`, `interactive`, `order`…). */
  tipoOriginal?: string;
  /** `true` = tipo que o CRM não sabe mostrar; `text` é só a marca para quem atende. */
  naoSuportado?: boolean;
  media: {
    id: string;
    /** A Meta manda URL pronta, com `ext=` de expiração — baixe na hora, não guarde. */
    url: string | null;
    mime: string | null;
    /** Nota de voz de verdade (não anexo de áudio). */
    voice: boolean;
  } | null;
  /**
   * `messages[].referral` cru — vem na mensagem que o app do cliente manda ao
   * clicar num anúncio "Clique para o WhatsApp". Repassado sem interpretar: a
   * leitura é de `extrairAtribuicaoMeta`. Opcional porque só a ingestão o lê.
   */
  referral?: unknown;
}

/** Status de entrega de uma mensagem que ENVIAMOS (sent/delivered/read/failed). */
export interface MessageStatusEvent {
  kind: "message_status";
  wabaId: string;
  externalId: string;
  status: string;
  recipient: string | null;
  errorCode: number | null;
  errorTitle: string | null;
}

/**
 * Mensagem que a EMPRESA enviou pelo app WhatsApp Business, num número em
 * coexistência (o mesmo número no app e na Cloud API). A Meta entrega no campo
 * `smb_message_echoes` — só o que saiu PELO APP; o que sai pela API não volta
 * como eco. Sem este evento a conversa no CRM fica sem as respostas dadas pelo
 * celular, e o agente responde por cima de um humano que já respondeu.
 *
 * `revoke` e `edit` também chegam por este campo e ficam de fora de propósito:
 * não são mensagem nova, e sim alteração de uma que talvez nem tenhamos gravado.
 */
export interface OutboundEchoEvent {
  kind: "outbound_echo";
  wabaId: string;
  /** Qual número NOSSO enviou — amarra o eco à sessão, como no recebimento. */
  phoneNumberId: string;
  /** `wamid` — mesma chave de idempotência das mensagens recebidas. */
  externalId: string;
  /** `wa_id` do CLIENTE (o destinatário). Mesma ressalva do nono dígito. */
  to: string;
  sentAt: Date;
  /** `text` | `image` | `video` | `document` | `contact` | … */
  type: string;
  text: string | null;
  /** Preenchido quando `type === "contact"` (cartão compartilhado pelo app). */
  sharedContact?: SharedContact | null;
  /** Ver `InboundMessageEvent`. */
  reply?: RespostaDeOpcao | null;
  tipoOriginal?: string;
  naoSuportado?: boolean;
  media: {
    id: string;
    url: string | null;
    mime: string | null;
    voice: boolean;
  } | null;
}

export type MetaWebhookEvent =
  | TemplateStatusEvent
  | MessageStatusEvent
  | InboundMessageEvent
  | OutboundEchoEvent;

/**
 * O formato do fio mora em `./envelope.ts`, onde é um schema Zod — e o tipo
 * NASCE dele (`z.infer`). Aqui era um `interface` escrita à mão, que o
 * `JSON.parse ... as` da rota prometia sem nunca conferir.
 */
export type { MetaWebhookEnvelope } from "./envelope";

/**
 * A Meta manda `rejected_reason: "NONE"` em template APROVADO (medido contra a WABA
 * real). Guardar o literal faz a tela anunciar um motivo de recusa que não existe.
 *
 * Mora aqui, no módulo puro, porque tem DOIS escritores da mesma coluna — o sync e
 * este webhook. Na prova ao vivo o webhook gravou `"NONE"` enquanto o sync gravava
 * `null`: a mesma linha ficava com convenções diferentes dependendo de quem a
 * tocou por último. Regra duplicada é regra que diverge.
 */
export function normalizeRejectedReason(v: unknown): string | null {
  const s = typeof v === "string" && v.length > 0 ? v : null;
  return s === null || s.toUpperCase() === "NONE" ? null : s;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Opção que o cliente tocou: botão de template (`button`), botão interativo
 * (`interactive.button_reply`) ou item de lista (`interactive.list_reply`).
 * `id` é o payload/id que a empresa definiu; `title`, o que o cliente leu.
 */
export interface RespostaDeOpcao {
  id: string | null;
  title: string;
  kind: "template_button" | "button_reply" | "list_reply";
  description?: string;
}

/**
 * Tipos da Meta que já são, um a um, valores aceitos por `messages_type_check`.
 * `contacts` (plural) vira `contact`; o resto é tratado em `tipoParaOCrm`.
 */
const TIPOS_DIRETOS = new Set([
  "text", "image", "video", "audio", "document", "sticker", "location", "reaction",
]);

interface TipoNormalizado {
  type: string;
  /** Texto da opção ou marca de não suportado; `undefined` = a regra antiga decide. */
  text?: string;
  reply?: RespostaDeOpcao;
  tipoOriginal?: string;
  naoSuportado?: boolean;
}

export function marcaDeNaoSuportado(tipo: string): string {
  return `[tipo de mensagem não suportado: ${tipo}]`;
}

/**
 * Traduz `messages[].type` para o vocabulário do banco. **Nunca devolve um tipo
 * que o CHECK recusa**: o insert falharia e a mensagem do cliente se perderia
 * (foi o que aconteceu com resposta de botão, que chegava como `button`).
 *
 * Resposta de botão ou lista vira `text` com o título da opção: para quem lê a
 * conversa, para o agente, para o STOP e para as automações por palavra, ela É o
 * que o cliente disse. O id da opção fica em `metadata.reply`.
 *
 * Qualquer outro tipo (`order`, `unsupported`, `system`, `nfm_reply`, os que a
 * Meta ainda vai inventar) vira `text` com uma marca visível e o tipo original
 * em `metadata.tipo_original` — gravado e sinalizado, nunca descartado.
 */
function tipoParaOCrm(tipo: string, raw: Record<string, unknown>): TipoNormalizado {
  if (tipo === "contacts") return { type: "contact" };
  if (TIPOS_DIRETOS.has(tipo)) return { type: tipo };

  if (tipo === "button") {
    const b = (raw.button ?? {}) as Record<string, unknown>;
    const title = str(b.text) ?? str(b.payload);
    if (title) {
      return {
        type: "text",
        text: title,
        reply: { id: str(b.payload), title, kind: "template_button" },
        tipoOriginal: tipo,
      };
    }
  }

  if (tipo === "interactive") {
    const it = (raw.interactive ?? {}) as Record<string, unknown>;
    const sub = str(it.type);
    if (sub === "button_reply" || sub === "list_reply") {
      const r = (it[sub] ?? {}) as Record<string, unknown>;
      const title = str(r.title) ?? str(r.id);
      if (title) {
        const description = str(r.description);
        return {
          type: "text",
          text: title,
          reply: { id: str(r.id), title, kind: sub, ...(description ? { description } : {}) },
          tipoOriginal: tipo,
        };
      }
    }
    const rotulo = sub ? `${tipo}:${sub}` : tipo;
    return { type: "text", text: marcaDeNaoSuportado(rotulo), tipoOriginal: rotulo, naoSuportado: true };
  }

  return { type: "text", text: marcaDeNaoSuportado(tipo), tipoOriginal: tipo, naoSuportado: true };
}

/** Campos opcionais do evento que só existem quando o tipo foi traduzido. */
function extrasDoTipo(n: TipoNormalizado) {
  return {
    ...(n.reply ? { reply: n.reply } : {}),
    ...(n.tipoOriginal ? { tipoOriginal: n.tipoOriginal } : {}),
    ...(n.naoSuportado ? { naoSuportado: true } : {}),
  };
}

/**
 * Extrai os eventos que nos interessam. **Evento desconhecido é IGNORADO, não erro** —
 * a Meta re-entrega tudo que não recebe 2xx, então devolver falha para um evento que
 * não nos interessa vira auto-DDoS: ela re-tenta o mesmo payload em backoff por horas.
 */
export function parseMetaWebhook(envelope: MetaWebhookEnvelope): MetaWebhookEvent[] {
  const out: MetaWebhookEvent[] = [];
  if (envelope?.object !== "whatsapp_business_account") return out;

  for (const entry of envelope.entry ?? []) {
    const wabaId = str(entry.id) ?? "";
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};

      if (change.field === "message_template_status_update") {
        const name = str(v.message_template_name);
        const language = str(v.message_template_language);
        if (!name || !language) continue; // payload capenga não vira linha meia-boca
        out.push({
          kind: "template_status",
          wabaId,
          templateName: name,
          templateLanguage: language,
          event: str(v.event) ?? "UNKNOWN",
          reason: normalizeRejectedReason(v.reason),
        });
        continue;
      }

      // Mensagens RECEBIDAS. Vem no mesmo `field: "messages"` das entregas — o que
      // separa é `messages[]` (do contato) vs `statuses[]` (das nossas). Tratar os
      // dois no mesmo `if` faria um mascarar o outro quando ambos vêm juntos.
      if (change.field === "messages" && Array.isArray(v.messages)) {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        const contatos = Array.isArray(v.contacts) ? (v.contacts as Record<string, unknown>[]) : [];
        for (const raw of v.messages as Record<string, unknown>[]) {
          const id = str(raw.id);
          const from = str(raw.from);
          if (!id || !from) continue; // payload capenga não vira linha meia-boca

          const perfil = contatos.find((c) => str(c.wa_id) === from);
          const tipo = str(raw.type) ?? "unknown";
          const corpoMidia = tipo !== "contacts" ? (raw[tipo] as Record<string, unknown> | undefined) : undefined;
          const sharedContact = tipo === "contacts" ? parseMetaInboundContact(raw) : null;
          const normalizado = tipoParaOCrm(tipo, raw);
          const tipoCrm = normalizado.type;

          out.push({
            kind: "inbound_message",
            wabaId,
            phoneNumberId: str(meta.phone_number_id) ?? "",
            externalId: id,
            from,
            profileName: str((perfil?.profile as Record<string, unknown> | undefined)?.name),
            // A Meta manda epoch em SEGUNDOS, string. Passar direto ao Date daria 1970.
            sentAt: new Date(Number(str(raw.timestamp) ?? "0") * 1000),
            type: tipoCrm,
            text:
              normalizado.text ??
              (tipoCrm === "text"
                ? str((raw.text as Record<string, unknown>)?.body)
                : sharedContact?.name ?? null),
            ...(sharedContact ? { sharedContact } : {}),
            ...extrasDoTipo(normalizado),
            // Tipo traduzido nunca carrega ponteiro de mídia: um balão de texto
            // com `meta-media:` dispararia a persistência de algo que não é mídia.
            media:
              !normalizado.tipoOriginal && corpoMidia && str(corpoMidia.id)
                ? {
                    id: str(corpoMidia.id)!,
                    url: str(corpoMidia.url),
                    mime: str(corpoMidia.mime_type),
                    voice: corpoMidia.voice === true,
                  }
                : null,
            referral: raw.referral ?? null,
          });
        }
        continue;
      }

      if (change.field === "messages" && Array.isArray(v.statuses)) {
        for (const raw of v.statuses as Record<string, unknown>[]) {
          const id = str(raw.id);
          if (!id) continue;
          const errors = Array.isArray(raw.errors)
            ? (raw.errors as Record<string, unknown>[])
            : [];
          const first = errors[0] ?? {};
          out.push({
            kind: "message_status",
            wabaId,
            externalId: id,
            status: str(raw.status) ?? "unknown",
            recipient: str(raw.recipient_id),
            errorCode: typeof first.code === "number" ? first.code : null,
            errorTitle: str(first.title),
          });
        }
      }
      // Coexistência: o que a empresa enviou pelo app WhatsApp Business.
      if (change.field === "smb_message_echoes" && Array.isArray(v.message_echoes)) {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        for (const raw of v.message_echoes as Record<string, unknown>[]) {
          const id = str(raw.id);
          const to = str(raw.to);
          const tipo = str(raw.type) ?? "unknown";
          if (!id || !to) continue; // payload capenga não vira linha meia-boca
          if (tipo === "revoke" || tipo === "edit") continue; // ver `OutboundEchoEvent`

          // Cartão chega como `contacts`, que o CHECK de `messages.type` recusa —
          // mesmo mapeamento da recebida, senão o insert falha e a IA não pausa.
          const corpoMidia = tipo !== "contacts" ? (raw[tipo] as Record<string, unknown> | undefined) : undefined;
          const sharedContact = tipo === "contacts" ? parseMetaInboundContact(raw) : null;
          const normalizado = tipoParaOCrm(tipo, raw);
          const tipoCrm = normalizado.type;
          out.push({
            kind: "outbound_echo",
            wabaId,
            phoneNumberId: str(meta.phone_number_id) ?? "",
            externalId: id,
            to,
            sentAt: new Date(Number(str(raw.timestamp) ?? "0") * 1000),
            type: tipoCrm,
            // Texto do balão: o corpo, o nome do cartão, ou a legenda da mídia.
            text:
              normalizado.text ??
              (tipoCrm === "text"
                ? str((raw.text as Record<string, unknown>)?.body)
                : sharedContact?.name ?? str(corpoMidia?.caption)),
            ...(sharedContact ? { sharedContact } : {}),
            ...extrasDoTipo(normalizado),
            // Tipo traduzido nunca carrega ponteiro de mídia: um balão de texto
            // com `meta-media:` dispararia a persistência de algo que não é mídia.
            media:
              !normalizado.tipoOriginal && corpoMidia && str(corpoMidia.id)
                ? {
                    id: str(corpoMidia.id)!,
                    url: str(corpoMidia.url),
                    mime: str(corpoMidia.mime_type),
                    voice: corpoMidia.voice === true,
                  }
                : null,
          });
        }
        continue;
      }
      // Qualquer outro `field` cai fora de propósito — ver o comentário acima.
    }
  }
  return out;
}
