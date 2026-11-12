import "server-only";

/**
 * Leitura de `public.billing_trigger_alarmes` (migration 0910, D-055; poda na
 * 1009, D-074) para a tela do administrador da INSTALAÇÃO
 * (`/admin/sistema/falhas-do-plano`).
 *
 * A tabela guarda a falha que o gatilho de contagem de leads do plano
 * (`fn_billing_trava_crm_leads`) engoliu para não barrar o lead. RLS ligada e
 * ZERO policy: só o `service_role` lê. Por isso quem chama isto é sempre uma
 * tela que JÁ conferiu `is_platform_admin` no servidor — a guarda não mora
 * aqui, mora na página (e no layout de `app/admin/(protected)`).
 *
 * Só leitura. Leitura que falhou devolve `leituraFalhou: true`, nunca lista
 * vazia: "nenhuma falha registrada" por acidente seria mentir para o admin
 * (mesmo cuidado de `lib/billing/asaas/leitura.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const FALHAS_POR_PAGINA = 50;

/** Janela do contador que aparece na entrada da tela. */
export const DIAS_DO_CONTADOR = 7;

export interface FalhaDoGatilho {
  id: string;
  criadoEm: string;
  organizationId: string;
  /** `null` quando a organização não foi encontrada (ex.: leitura dos nomes falhou). */
  organizacaoNome: string | null;
  gatilho: string;
  falha: string;
}

export interface ResultadoFalhasDoGatilho {
  falhas: FalhaDoGatilho[];
  temMais: boolean;
  leituraFalhou: boolean;
}

interface LinhaCrua {
  id: string;
  organization_id: string;
  gatilho: string;
  falha: string;
  criado_em: string;
}

/** Uma página da lista, do mais novo para o mais velho. `pagina` começa em 1. */
export async function falhasDoGatilhoDePlano(
  admin: SupabaseClient,
  pagina: number,
): Promise<ResultadoFalhasDoGatilho> {
  const inicio = (Math.max(1, Math.floor(pagina)) - 1) * FALHAS_POR_PAGINA;
  try {
    // Pede uma linha a mais só para saber se existe próxima página.
    const { data, error } = await admin
      .from("billing_trigger_alarmes")
      .select("id, organization_id, gatilho, falha, criado_em")
      .order("criado_em", { ascending: false })
      .order("id", { ascending: false })
      .range(inicio, inicio + FALHAS_POR_PAGINA);
    if (error) throw new Error(error.message);

    const linhas = (data ?? []) as LinhaCrua[];
    const temMais = linhas.length > FALHAS_POR_PAGINA;
    const visiveis = linhas.slice(0, FALHAS_POR_PAGINA);

    const ids = [...new Set(visiveis.map((l) => l.organization_id))];
    const nomes = new Map<string, string>();
    if (ids.length > 0) {
      const { data: orgs, error: erroOrgs } = await admin
        .from("organizations")
        .select("id, name")
        .in("id", ids);
      // Sem o nome a tela ainda é útil (mostra o id); não vira leituraFalhou.
      if (!erroOrgs) {
        for (const o of (orgs ?? []) as { id: string; name: string | null }[]) {
          if (o.name) nomes.set(o.id, o.name);
        }
      }
    }

    return {
      falhas: visiveis.map((l) => ({
        id: l.id,
        criadoEm: l.criado_em,
        organizationId: l.organization_id,
        organizacaoNome: nomes.get(l.organization_id) ?? null,
        gatilho: l.gatilho,
        falha: l.falha,
      })),
      temMais,
      leituraFalhou: false,
    };
  } catch {
    return { falhas: [], temMais: false, leituraFalhou: true };
  }
}

/** Quantas falhas nos últimos `DIAS_DO_CONTADOR` dias. `null` = não deu para contar. */
export async function contarFalhasRecentesDoGatilho(
  admin: SupabaseClient,
  agora: number = Date.now(),
): Promise<number | null> {
  try {
    const desde = new Date(agora - DIAS_DO_CONTADOR * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await admin
      .from("billing_trigger_alarmes")
      .select("id", { count: "exact", head: true })
      .gte("criado_em", desde);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}
