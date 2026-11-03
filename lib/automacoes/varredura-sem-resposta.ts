/**
 * Gatilho "Contato sem resposta" (`no_reply`) — TIME-DRIVEN, como o silêncio
 * dos follow-ups (`lib/followup/silence-sweep.ts`): não há evento para a
 * ausência de resposta, então quem percebe é o relógio. Roda no mesmo tick do
 * cron `followup-flow-worker` (1×/min), ao lado da varredura de silêncio.
 *
 * Regra: a ÚLTIMA mensagem da conversa é nossa (`last_outbound_at`), saiu há
 * pelo menos `after_minutes` e o contato não escreveu depois dela
 * (`last_inbound_at` anterior ou nulo). Grupo nunca entra.
 *
 * Idempotência: o `origin_event_id` é determinístico — automação + conversa +
 * id da última mensagem enviada. A mesma espera sem resposta vista de novo no
 * minuto seguinte dá `duplicada`; uma mensagem nossa NOVA abre outra espera.
 *
 * Anti-laço: a mensagem enviada pela PRÓPRIA automação
 * (`metadata.origem_automacao.pointer_id`) não arma a espera dela de novo —
 * senão "sem resposta → manda lembrete" giraria a cada `after_minutes`.
 *
 * Só olha conversas cuja última saída caiu na janela
 * [agora − after − JANELA, agora − after]: depois de uma parada do relógio
 * maior que a janela, a espera antiga não ressuscita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaBloqueadaParaProduzir } from "@/lib/billing/assinatura/pode-produzir";

import {
  automacoesComGatilho,
  origensJaIniciadas,
  uuidDeterministico,
  type AutomacaoArmada,
} from "./armadas";
import { iniciarAutomacao, type InicioDaAutomacao } from "./iniciar";
import { CHAVE_DE_ORIGEM_AUTOMACAO } from "./teto-de-mensagens";

/** Quanto para trás da marca de `after_minutes` a varredura ainda olha. */
export const JANELA_DA_VARREDURA_SEM_RESPOSTA_MIN = 60;
/** Conversas por automação por rodada. */
export const TETO_DE_CONVERSAS_SEM_RESPOSTA = 200;

export interface ConversaCandidata {
  id: string;
  contact_id: string;
  last_outbound_at: string;
  last_inbound_at: string | null;
}

export interface UltimaSaida {
  id: string;
  /** O pointer da automação que enviou, quando foi uma. */
  pointer_id: string | null;
}

export interface SemRespostaDb {
  automacoesArmadas(): Promise<Array<AutomacaoArmada<"no_reply">>>;
  modoLeitura(orgId: string): Promise<boolean>;
  conversasCandidatas(
    orgId: string,
    desdeIso: string,
    ateIso: string,
  ): Promise<ConversaCandidata[]>;
  ultimaSaida(orgId: string, conversationId: string): Promise<UltimaSaida | null>;
  jaIniciadas(orgId: string, pointerId: string, origens: string[]): Promise<Set<string>>;
  iniciar(input: Parameters<typeof iniciarAutomacao>[1]): Promise<InicioDaAutomacao>;
}

export interface ResumoSemResposta {
  automacoes: number;
  candidatas: number;
  iniciadas: number;
  ignoradas: number;
  falhas: number;
}

/** O contato não respondeu à última saída? Pura: lê só os carimbos da conversa. */
export function semRespostaDesde(
  c: Pick<ConversaCandidata, "last_outbound_at" | "last_inbound_at">,
): boolean {
  const saida = Date.parse(c.last_outbound_at);
  if (!Number.isFinite(saida)) return false;
  if (!c.last_inbound_at) return true;
  const entrada = Date.parse(c.last_inbound_at);
  return !Number.isFinite(entrada) || entrada < saida;
}

export function origemSemResposta(
  pointerId: string,
  conversationId: string,
  ultimaSaidaId: string,
): string {
  return uuidDeterministico("automacao:no_reply", pointerId, conversationId, ultimaSaidaId);
}

export async function varrerSemResposta(
  db: SemRespostaDb,
  agora: Date,
): Promise<ResumoSemResposta> {
  const resumo: ResumoSemResposta = {
    automacoes: 0,
    candidatas: 0,
    iniciadas: 0,
    ignoradas: 0,
    falhas: 0,
  };
  const armadas = await db.automacoesArmadas();
  const modoLeitura = new Map<string, boolean>();
  for (const a of armadas) {
    resumo.automacoes++;
    try {
      if (!modoLeitura.has(a.organization_id)) {
        modoLeitura.set(a.organization_id, await db.modoLeitura(a.organization_id));
      }
      if (modoLeitura.get(a.organization_id)) continue;
      // Vários "sem resposta" na mesma automação: cada um olha a própria janela.
      for (const g of a.gatilhos) {
        const ate = new Date(agora.getTime() - g.after_minutes * 60_000);
        const desde = new Date(ate.getTime() - JANELA_DA_VARREDURA_SEM_RESPOSTA_MIN * 60_000);
        const candidatas = (
          await db.conversasCandidatas(a.organization_id, desde.toISOString(), ate.toISOString())
        )
          .filter(semRespostaDesde)
          .slice(0, TETO_DE_CONVERSAS_SEM_RESPOSTA);
        resumo.candidatas += candidatas.length;
        const prontas: Array<{ c: ConversaCandidata; saida: UltimaSaida; origem: string }> = [];
        for (const c of candidatas) {
          const saida = await db.ultimaSaida(a.organization_id, c.id);
          if (!saida || saida.pointer_id === a.id) {
            resumo.ignoradas++;
            continue;
          }
          prontas.push({ c, saida, origem: origemSemResposta(a.id, c.id, saida.id) });
        }
        if (prontas.length === 0) continue;
        const ja = await db.jaIniciadas(
          a.organization_id,
          a.id,
          prontas.map((p) => p.origem),
        );
        for (const p of prontas) {
          if (ja.has(p.origem)) continue;
          const r = await db.iniciar({
            organizationId: a.organization_id,
            pointerId: a.id,
            contactId: p.c.contact_id,
            vars: {
              gatilho: {
                tipo: "no_reply",
                conversation_id: p.c.id,
                last_message_id: p.saida.id,
                after_minutes: g.after_minutes,
              },
            },
            originEventId: p.origem,
            parentEnrollmentId: null,
          });
          if (r.resultado === "iniciada" || r.resultado === "reiniciada") resumo.iniciadas++;
          else resumo.ignoradas++;
        }
      }
    } catch {
      // Uma automação torta não cala a varredura das outras.
      resumo.falhas++;
    }
  }
  return resumo;
}

export function createSupabaseSemRespostaDb(admin: SupabaseClient): SemRespostaDb {
  return {
    automacoesArmadas: () => automacoesComGatilho(admin, "no_reply"),
    modoLeitura: (orgId) => contaBloqueadaParaProduzir(admin, orgId),
    async conversasCandidatas(orgId, desdeIso, ateIso) {
      const { data, error } = await admin
        .from("conversations")
        .select("id, contact_id, last_outbound_at, last_inbound_at")
        .eq("organization_id", orgId)
        .eq("is_group", false)
        .gte("last_outbound_at", desdeIso)
        .lte("last_outbound_at", ateIso)
        .order("last_outbound_at", { ascending: true })
        .limit(TETO_DE_CONVERSAS_SEM_RESPOSTA * 2);
      if (error) throw new Error(error.message);
      return (data ?? []) as ConversaCandidata[];
    },
    async ultimaSaida(orgId, conversationId) {
      const { data, error } = await admin
        .from("messages")
        .select("id, metadata")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "outbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const m = data as { id: string; metadata: Record<string, unknown> | null };
      const origem = m.metadata?.[CHAVE_DE_ORIGEM_AUTOMACAO] as
        { pointer_id?: unknown } | undefined;
      return {
        id: m.id,
        pointer_id: typeof origem?.pointer_id === "string" ? origem.pointer_id : null,
      };
    },
    jaIniciadas: (orgId, pointerId, origens) =>
      origensJaIniciadas(admin, orgId, pointerId, origens),
    iniciar: (input) => iniciarAutomacao(admin, input),
  };
}
