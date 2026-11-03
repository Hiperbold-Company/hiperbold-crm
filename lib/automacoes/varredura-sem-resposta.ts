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
 * Anti-laço entre automações (A ↔ B): quando a última saída veio de OUTRA
 * automação, a execução que a enviou vira o `parent_enrollment_id` da nova —
 * e a guarda de ciclo e cadeia do `fn_automacao_iniciar` corta A → B → A.
 *
 * Quem NÃO entra: conversa que não está aberta (resolvida, fechada,
 * arquivada), última saída que FALHOU (o contato nem recebeu), saída de
 * CAMPANHA (`metadata.source = campaign`/`campaign_test` ou `campaign_id`: o
 * disparo em massa não é conversa à espera de resposta), e conversa com HUMANO
 * no comando (atendente responsável, `force_human`, IA silenciada — o mesmo
 * critério de `humanoNoComando`, que o gatilho de retorno e o gate da IA usam).
 *
 * Só olha conversas cuja última saída caiu na janela
 * [agora − after − JANELA, agora − after]: depois de uma parada do relógio
 * maior que a janela, a espera antiga não ressuscita. Dentro da janela a
 * varredura PAGINA (da saída mais antiga para a mais nova) e pula as origens
 * já iniciadas, então nenhuma conversa fica de fora por haver mais candidatas
 * que uma página; a última saída de cada página é lida numa consulta só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaBloqueadaParaProduzir } from "@/lib/billing/assinatura/pode-produzir";
import { humanoNoComando } from "@/lib/followup/gatilho-retorno";

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
/** Conversas por página. */
export const TETO_DE_CONVERSAS_SEM_RESPOSTA = 200;
/** Páginas por gatilho por rodada (freio de custo: 25 × 200 = 5000 conversas). */
export const PAGINAS_DA_VARREDURA_SEM_RESPOSTA = 25;

/** Status de conversa que contam como ABERTA para "sem resposta". */
export const STATUS_DE_CONVERSA_FECHADA = ["resolved", "closed", "archived"] as const;

export interface ConversaCandidata {
  id: string;
  contact_id: string;
  last_outbound_at: string;
  last_inbound_at: string | null;
  status?: string | null;
  assignee_kind?: string | null;
  bot_silenced_until?: string | null;
  force_human?: boolean | null;
}

export interface UltimaSaida {
  id: string;
  /** O pointer da automação que enviou, quando foi uma. */
  pointer_id: string | null;
  /** A execução da automação que enviou, quando foi uma (vira a execução-mãe). */
  enrollment_id?: string | null;
  status?: string | null;
  /** Saída de campanha (disparo em massa). */
  campanha?: boolean;
}

export interface SemRespostaDb {
  automacoesArmadas(): Promise<Array<AutomacaoArmada<"no_reply">>>;
  modoLeitura(orgId: string): Promise<boolean>;
  /** Uma página (ordem: última saída mais antiga primeiro, depois id). */
  conversasCandidatas(
    orgId: string,
    desdeIso: string,
    ateIso: string,
    pagina?: { offset: number; limite: number },
  ): Promise<ConversaCandidata[]>;
  /** A última saída de cada conversa dada, numa leitura só. */
  ultimasSaidas(orgId: string, conversas: ConversaCandidata[]): Promise<Map<string, UltimaSaida>>;
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

/** A conversa está aberta e sem humano no comando? Pura. */
export function conversaElegivelSemResposta(c: ConversaCandidata, agora: Date): boolean {
  if (c.status && (STATUS_DE_CONVERSA_FECHADA as readonly string[]).includes(c.status)) return false;
  return !humanoNoComando(
    {
      is_group: false,
      is_blocked: false,
      tags: [],
      force_human: c.force_human === true,
      assignee_kind: c.assignee_kind ?? null,
      bot_silenced_until: c.bot_silenced_until ?? null,
    },
    agora,
  );
}

/** A saída é de campanha? `metadata.source` ou `metadata.campaign_id` (`lib/campanhas/rodada.ts`). */
export function saidaDeCampanha(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  const fonte = metadata.source;
  if (fonte === "campaign" || fonte === "campaign_test") return true;
  return typeof metadata.campaign_id === "string" && metadata.campaign_id.length > 0;
}

export function origemSemResposta(
  pointerId: string,
  conversationId: string,
  ultimaSaidaId: string,
): string {
  return uuidDeterministico("automacao:no_reply", pointerId, conversationId, ultimaSaidaId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        for (let pagina = 0; pagina < PAGINAS_DA_VARREDURA_SEM_RESPOSTA; pagina++) {
          const lidas = await db.conversasCandidatas(a.organization_id, desde.toISOString(), ate.toISOString(), {
            offset: pagina * TETO_DE_CONVERSAS_SEM_RESPOSTA,
            limite: TETO_DE_CONVERSAS_SEM_RESPOSTA,
          });
          const candidatas = lidas.filter((c) => semRespostaDesde(c) && conversaElegivelSemResposta(c, agora));
          resumo.ignoradas += lidas.length - candidatas.length;
          resumo.candidatas += candidatas.length;
          await iniciarDaPagina(db, a, g.after_minutes, candidatas, resumo);
          if (lidas.length < TETO_DE_CONVERSAS_SEM_RESPOSTA) break;
        }
      }
    } catch {
      // Uma automação torta não cala a varredura das outras.
      resumo.falhas++;
    }
  }
  return resumo;
}

async function iniciarDaPagina(
  db: SemRespostaDb,
  a: AutomacaoArmada<"no_reply">,
  afterMinutes: number,
  candidatas: ConversaCandidata[],
  resumo: ResumoSemResposta,
): Promise<void> {
  if (candidatas.length === 0) return;
  const saidas = await db.ultimasSaidas(a.organization_id, candidatas);
  const prontas: Array<{ c: ConversaCandidata; saida: UltimaSaida; origem: string }> = [];
  for (const c of candidatas) {
    const saida = saidas.get(c.id);
    // Sem saída, saída que falhou, de campanha, ou da PRÓPRIA automação (anti-laço).
    if (!saida || saida.status === "failed" || saida.campanha === true || saida.pointer_id === a.id) {
      resumo.ignoradas++;
      continue;
    }
    prontas.push({ c, saida, origem: origemSemResposta(a.id, c.id, saida.id) });
  }
  if (prontas.length === 0) return;
  const ja = await db.jaIniciadas(
    a.organization_id,
    a.id,
    prontas.map((p) => p.origem),
  );
  for (const p of prontas) {
    if (ja.has(p.origem)) continue;
    const mae = p.saida.enrollment_id && UUID.test(p.saida.enrollment_id) ? p.saida.enrollment_id : null;
    const r = await db.iniciar({
      organizationId: a.organization_id,
      pointerId: a.id,
      contactId: p.c.contact_id,
      vars: {
        gatilho: {
          tipo: "no_reply",
          conversation_id: p.c.id,
          last_message_id: p.saida.id,
          after_minutes: afterMinutes,
        },
      },
      originEventId: p.origem,
      // A saída foi de outra automação: a execução dela é a mãe (ciclo A ↔ B).
      parentEnrollmentId: mae,
    });
    if (r.resultado === "iniciada" || r.resultado === "reiniciada") resumo.iniciadas++;
    else resumo.ignoradas++;
  }
}

interface LinhaDeConversa {
  id: string;
  contact_id: string;
  last_outbound_at: string;
  last_inbound_at: string | null;
  status: string | null;
  assignee_kind: string | null;
  bot_silenced_until: string | null;
  contacts: { force_human: boolean | null } | null;
}

/** Folga para trás da última saída ao ler as mensagens (o carimbo e o `created_at` podem diferir). */
const FOLGA_DA_LEITURA_MS = 10 * 60_000;

export function createSupabaseSemRespostaDb(admin: SupabaseClient): SemRespostaDb {
  async function ultimaSaidaDe(orgId: string, conversationId: string) {
    const { data, error } = await admin
      .from("messages")
      .select("id, conversation_id, status, metadata, created_at")
      .eq("organization_id", orgId)
      .eq("conversation_id", conversationId)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as LinhaDeSaida | null;
  }
  return {
    automacoesArmadas: () => automacoesComGatilho(admin, "no_reply"),
    modoLeitura: (orgId) => contaBloqueadaParaProduzir(admin, orgId),
    async conversasCandidatas(orgId, desdeIso, ateIso, pagina) {
      const offset = pagina?.offset ?? 0;
      const limite = pagina?.limite ?? TETO_DE_CONVERSAS_SEM_RESPOSTA;
      const { data, error } = await admin
        .from("conversations")
        .select(
          "id, contact_id, last_outbound_at, last_inbound_at, status, assignee_kind, bot_silenced_until, contacts:contact_id(force_human)",
        )
        .eq("organization_id", orgId)
        .eq("is_group", false)
        .not("status", "in", `(${STATUS_DE_CONVERSA_FECHADA.join(",")})`)
        .gte("last_outbound_at", desdeIso)
        .lte("last_outbound_at", ateIso)
        .order("last_outbound_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limite - 1);
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as LinhaDeConversa[]).map((c) => ({
        id: c.id,
        contact_id: c.contact_id,
        last_outbound_at: c.last_outbound_at,
        last_inbound_at: c.last_inbound_at,
        status: c.status,
        assignee_kind: c.assignee_kind,
        bot_silenced_until: c.bot_silenced_until,
        force_human: c.contacts?.force_human ?? false,
      }));
    },
    async ultimasSaidas(orgId, conversas) {
      const mapa = new Map<string, UltimaSaida>();
      if (conversas.length === 0) return mapa;
      const piso = Math.min(...conversas.map((c) => Date.parse(c.last_outbound_at)).filter(Number.isFinite));
      const { data, error } = await admin
        .from("messages")
        .select("id, conversation_id, status, metadata, created_at")
        .eq("organization_id", orgId)
        .eq("direction", "outbound")
        .in(
          "conversation_id",
          conversas.map((c) => c.id),
        )
        .gte("created_at", new Date((Number.isFinite(piso) ? piso : Date.now()) - FOLGA_DA_LEITURA_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw new Error(error.message);
      for (const m of (data ?? []) as LinhaDeSaida[]) {
        if (!mapa.has(m.conversation_id)) mapa.set(m.conversation_id, paraUltimaSaida(m));
      }
      // Fora da leitura em lote (carimbo torto, página cheia): uma a uma, só as que faltaram.
      for (const c of conversas) {
        if (mapa.has(c.id)) continue;
        const m = await ultimaSaidaDe(orgId, c.id);
        if (m) mapa.set(c.id, paraUltimaSaida(m));
      }
      return mapa;
    },
    jaIniciadas: (orgId, pointerId, origens) =>
      origensJaIniciadas(admin, orgId, pointerId, origens),
    iniciar: (input) => iniciarAutomacao(admin, input),
  };
}

interface LinhaDeSaida {
  id: string;
  conversation_id: string;
  status: string | null;
  metadata: Record<string, unknown> | null;
}

function paraUltimaSaida(m: LinhaDeSaida): UltimaSaida {
  const origem = m.metadata?.[CHAVE_DE_ORIGEM_AUTOMACAO] as
    | { pointer_id?: unknown; enrollment_id?: unknown }
    | undefined;
  return {
    id: m.id,
    pointer_id: typeof origem?.pointer_id === "string" ? origem.pointer_id : null,
    enrollment_id: typeof origem?.enrollment_id === "string" ? origem.enrollment_id : null,
    status: m.status,
    campanha: saidaDeCampanha(m.metadata),
  };
}
