/**
 * Gatilho "Data de um campo do negócio" (`date_field`) — a varredura de relógio
 * das automações, chamada pelo cron `lead-date-field-due` (de hora em hora, no
 * minuto 23) ao lado das regras antigas, que seguem como eram.
 *
 * O dia: o negócio casa quando `data do campo + offset_days = hoje` no fuso da
 * organização (`offset_days: -3` = três dias ANTES da data). A comparação de
 * data é a mesma das regras (`casaNaData`, que aceita ISO, timestamp e
 * `dd/mm/aaaa`).
 *
 * A hora: a execução começa na primeira rodada em que o relógio local passou de
 * `time`, dentro de uma janela de `JANELA_DO_HORARIO_MIN` — como o cron roda de
 * hora em hora, `09:00` começa por volta de 09:23 e `09:40` por volta de 10:23.
 * A janela cobre uma rodada perdida sem fazer o dia inteiro reconsultar.
 *
 * Quais negócios: por padrão só os ABERTOS (`only_open`, ausente = sim) — o
 * aniversário de contrato de um negócio perdido não manda mensagem. A leitura
 * PAGINA (por `id`) e pula as origens já iniciadas: nenhum negócio fica de fora
 * por haver mais de uma página no mesmo dia.
 *
 * Idempotência: `origin_event_id` determinístico de automação + negócio + data
 * (+ campo e antecedência, para dois gatilhos de data na mesma automação). A
 * mesma data vista na rodada seguinte dá `duplicada`; mudar a data do negócio
 * para outro dia arma de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaBloqueadaParaProduzir } from "@/lib/billing/assinatura/pode-produzir";
import {
  diaLocal,
  fusoDaOrganizacao,
  relogioDaOrganizacao,
  TETO_POR_ORGANIZACAO,
} from "@/lib/automation/cron-de-data";
import { casaNaData, diaBrasileiro, somarDias } from "@/lib/automation/gatilho-de-data-do-funil";

import {
  automacoesComGatilho,
  origensJaIniciadas,
  uuidDeterministico,
  type AutomacaoArmada,
} from "./armadas";
import { iniciarAutomacao, type InicioDaAutomacao } from "./iniciar";
import type { AutomacaoTrigger, CampoDeDataDoNegocio } from "./schemas";

/** Depois do horário, por quantos minutos a varredura ainda inicia. */
export const JANELA_DO_HORARIO_MIN = 180;
/** Páginas de `TETO_POR_ORGANIZACAO` negócios por gatilho por rodada (freio de custo). */
export const PAGINAS_DA_VARREDURA_DE_DATA = 25;

type GatilhoDeData = Extract<AutomacaoTrigger, { kind: "date_field" }>;

export interface NegocioComData {
  id: string;
  contact_id: string | null;
  valor: unknown;
}

export interface DataDoNegocioDb {
  automacoesArmadas(): Promise<Array<AutomacaoArmada<"date_field">>>;
  fusoDaOrganizacao(orgId: string): Promise<string | null>;
  modoLeitura(orgId: string): Promise<boolean>;
  /**
   * Superconjunto: negócios cujo campo PODE ser `dia` (o TypeScript decide com
   * `casaNaData`), uma página por vez, em ordem estável de `id`.
   */
  negociosNaData(
    orgId: string,
    campo: CampoDeDataDoNegocio,
    dia: string,
    pagina?: { offset: number; limite: number; apenasAbertos: boolean },
  ): Promise<NegocioComData[]>;
  jaIniciadas(orgId: string, pointerId: string, origens: string[]): Promise<Set<string>>;
  iniciar(input: Parameters<typeof iniciarAutomacao>[1]): Promise<InicioDaAutomacao>;
}

export interface ResumoDataDoNegocio {
  automacoes: number;
  candidatos: number;
  iniciadas: number;
  ignoradas: number;
  falhas: number;
}

/** O relógio local está entre `time` e `time + janela`, no mesmo dia? Pura. */
export function dentroDoHorario(
  hora: number,
  minuto: number,
  time: string,
  janelaMin = JANELA_DO_HORARIO_MIN,
): boolean {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return false;
  const agora = hora * 60 + minuto;
  const inicio = h! * 60 + m!;
  return agora >= inicio && agora < inicio + janelaMin;
}

/** A data que o campo precisa ter HOJE para casar: `hoje − offset_days`. */
export function dataProcurada(hojeLocal: string, offsetDias: number): string {
  return somarDias(hojeLocal, -offsetDias);
}

export function origemDaData(
  pointerId: string,
  leadId: string,
  data: string,
  g: GatilhoDeData,
): string {
  return uuidDeterministico(
    "automacao:date_field",
    pointerId,
    leadId,
    data,
    `${g.field.scope}.${g.field.key}`,
    String(g.offset_days),
  );
}

export async function varrerDatasDasAutomacoes(
  db: DataDoNegocioDb,
  agora: Date,
): Promise<ResumoDataDoNegocio> {
  const resumo: ResumoDataDoNegocio = {
    automacoes: 0,
    candidatos: 0,
    iniciadas: 0,
    ignoradas: 0,
    falhas: 0,
  };
  const armadas = await db.automacoesArmadas();
  for (const a of armadas) {
    resumo.automacoes++;
    try {
      const fuso = fusoDaOrganizacao(await db.fusoDaOrganizacao(a.organization_id));
      const relogio = relogioDaOrganizacao(agora, fuso);
      const hoje = diaLocal(agora, fuso);
      const daHora = a.gatilhos.filter((g) =>
        dentroDoHorario(relogio.hora, relogio.minuto, g.time),
      );
      if (daHora.length === 0) continue;
      if (await db.modoLeitura(a.organization_id)) continue;
      for (const g of daHora) {
        const dia = dataProcurada(hoje, g.offset_days);
        if (!dia) continue;
        const apenasAbertos = g.only_open !== false;
        for (let pagina = 0; pagina < PAGINAS_DA_VARREDURA_DE_DATA; pagina++) {
          const lidos = await db.negociosNaData(a.organization_id, g.field, dia, {
            offset: pagina * TETO_POR_ORGANIZACAO,
            limite: TETO_POR_ORGANIZACAO,
            apenasAbertos,
          });
          const casam = lidos.filter(
            (n) => n.contact_id && casaNaData(n.valor, hoje, -g.offset_days),
          );
          resumo.candidatos += casam.length;
          if (casam.length > 0) {
            const comOrigem = casam.map((n) => ({ n, origem: origemDaData(a.id, n.id, dia, g) }));
            const ja = await db.jaIniciadas(
              a.organization_id,
              a.id,
              comOrigem.map((c) => c.origem),
            );
            for (const { n, origem } of comOrigem) {
              if (ja.has(origem)) continue;
              const r = await db.iniciar({
                organizationId: a.organization_id,
                pointerId: a.id,
                contactId: n.contact_id!,
                vars: {
                  _lead_id: n.id,
                  gatilho: {
                    tipo: "date_field",
                    lead_id: n.id,
                    campo: g.field.key,
                    data: dia,
                    offset_days: g.offset_days,
                  },
                },
                originEventId: origem,
                parentEnrollmentId: null,
              });
              if (r.resultado === "iniciada" || r.resultado === "reiniciada") resumo.iniciadas++;
              else resumo.ignoradas++;
            }
          }
          if (lidos.length < TETO_POR_ORGANIZACAO) break;
        }
      }
    } catch {
      // Fuso digitado errado ou consulta que falha numa automação não cala as outras.
      resumo.falhas++;
    }
  }
  return resumo;
}

export function createSupabaseDataDoNegocioDb(admin: SupabaseClient): DataDoNegocioDb {
  const fusos = new Map<string, string | null>();
  return {
    automacoesArmadas: () => automacoesComGatilho(admin, "date_field"),
    async fusoDaOrganizacao(orgId) {
      if (fusos.has(orgId)) return fusos.get(orgId) ?? null;
      const { data, error } = await admin
        .from("organizations")
        .select("timezone")
        .eq("id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const tz = (data as { timezone: string | null } | null)?.timezone ?? null;
      fusos.set(orgId, tz);
      return tz;
    },
    modoLeitura: (orgId) => contaBloqueadaParaProduzir(admin, orgId),
    async negociosNaData(orgId, campo, dia, pagina) {
      const offset = pagina?.offset ?? 0;
      const limite = pagina?.limite ?? TETO_POR_ORGANIZACAO;
      const apenasAbertos = pagina?.apenasAbertos ?? true;
      if (campo.scope === "lead") {
        let q = admin
          .from("crm_leads")
          .select("id, contact_id, expected_close_date")
          .eq("organization_id", orgId)
          .eq("expected_close_date", dia);
        if (apenasAbertos) q = q.eq("status", "open");
        const { data, error } = await q
          .order("id", { ascending: true })
          .range(offset, offset + limite - 1);
        if (error) throw new Error(error.message);
        return (
          (data ?? []) as Array<{
            id: string;
            contact_id: string | null;
            expected_close_date: unknown;
          }>
        ).map((l) => ({
          id: l.id,
          contact_id: l.contact_id,
          valor: l.expected_close_date,
        }));
      }
      // A chave já passou pelo regex do schema (letra, depois letras, números e
      // underscore): não acrescenta condição ao `.or()` (mesma guarda do D-167).
      const k = campo.key;
      let q = admin
        .from("crm_leads")
        .select("id, contact_id, custom_fields")
        .eq("organization_id", orgId)
        .or(`custom_fields->>${k}.like.*${dia}*,custom_fields->>${k}.like.*${diaBrasileiro(dia)}*`);
      if (apenasAbertos) q = q.eq("status", "open");
      const { data, error } = await q
        .order("id", { ascending: true })
        .range(offset, offset + limite - 1);
      if (error) throw new Error(error.message);
      return (
        (data ?? []) as Array<{
          id: string;
          contact_id: string | null;
          custom_fields: Record<string, unknown> | null;
        }>
      ).map((l) => ({ id: l.id, contact_id: l.contact_id, valor: l.custom_fields?.[k] }));
    },
    jaIniciadas: (orgId, pointerId, origens) =>
      origensJaIniciadas(admin, orgId, pointerId, origens),
    iniciar: (input) => iniciarAutomacao(admin, input),
  };
}
