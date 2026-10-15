/**
 * A organização que ainda NÃO TEM PLANO (D-094 revisto, migração 0940): a que nasceu do cadastro
 * do próprio visitante e ainda não pagou nada.
 *
 * ─── Como ela é representada ────────────────────────────────────────────────
 *
 * Sem estado novo no modelo de billing: o contrato nasce `suspensa`, sem período
 * (`current_period_end` nulo), sem ciclo e com `bloqueio_a_partir_de` já vencido
 * (`fn_billing_contrato_da_organizacao_nova`, 0940). Uma suspensão por falta de pagamento sempre
 * tem período (o conferidor da 0908 só muda contrato com período), então "suspensa sem período e
 * sem ciclo" é inequívoco: nunca houve assinatura.
 *
 * O bloqueio de verdade (IA, automação, campanha, follow-up, importação, criação de funil) é o
 * modo leitura que já existe, `fn_billing_modo_leitura`. Este arquivo só serve a PÁGINA: leva
 * quem entra em /app para a tela de assinatura, que é onde esta organização tem o que fazer.
 *
 * ─── Só no modo `bloquear` ──────────────────────────────────────────────────
 *
 * Como o resto do billing, a guarda só vale com `billing_settings.modo = 'bloquear'`. Em `avisar`
 * ou `desligado` a instalação ainda não cobra, e mandar o usuário para uma tela de pagamento seria
 * cobrar sem dizer. Sai sem consulta nenhuma ao contrato nesses modos (o modo vem do cache de 60s).
 *
 * ─── Fail-open ──────────────────────────────────────────────────────────────
 *
 * Mesma doutrina de `modo-leitura.ts`: leitura que falha NÃO prende o usuário fora do produto
 * (devolve `false`) e grita `alarme_planos_leitura`. A guarda é conveniência de navegação; quem
 * barra o uso é o banco e os produtores, que não dependem desta página.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";

/** Para onde a organização sem plano é levada. */
export const CAMINHO_DA_ASSINATURA = "/app/settings/plano/assinar";

/**
 * O que a organização sem plano alcança: a tela de assinatura (e o pedido que ela abre), as
 * configurações básicas (conta do usuário, segurança, avisos, dados da empresa) e o índice delas.
 * O onboarding mora fora de /app e não passa por aqui. Prefixo por segmento inteiro:
 * `/app/settings/plano-x` não herda a permissão de `/app/settings/plano`.
 */
const PREFIXOS_LIVRES = [
  "/app/settings/plano",
  "/app/settings/profile",
  "/app/settings/security",
  "/app/settings/notifications",
];
const CAMINHOS_EXATOS_LIVRES = ["/app/settings", "/app/settings/tenant"];

/** O caminho (sem query) pode ser aberto por uma organização sem plano? */
export function caminhoLivreSemPlano(pathname: string): boolean {
  const caminho = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (CAMINHOS_EXATOS_LIVRES.includes(caminho)) return true;
  return PREFIXOS_LIVRES.some((prefixo) => caminho === prefixo || caminho.startsWith(`${prefixo}/`));
}

export interface ContratoParaSemPlano {
  status: string;
  currentPeriodEnd: string | null;
  cycle: string | null;
}

/** "Suspensa que nunca assinou": sem período e sem ciclo. Função pura. */
export function contratoSemPlano(contrato: ContratoParaSemPlano | null | undefined): boolean {
  if (!contrato) return false;
  return contrato.status === "suspensa" && !contrato.currentPeriodEnd && !contrato.cycle;
}

/**
 * Esta organização está sem plano E o bloqueio está valendo? Nunca lança.
 * `modo !== 'bloquear'` sai antes de consultar o contrato.
 */
export async function organizacaoSemPlano(
  admin: SupabaseClient,
  organizationId: string,
  opcoes: { semCarencia?: boolean } = {},
): Promise<boolean> {
  try {
    const { modo, error: erroModo } = await modoDeBillingCacheado(admin);
    if (erroModo) throw new Error(`ler billing_settings: ${erroModo}`);
    if (modo !== "bloquear") return false;

    const { data, error } = await admin
      .from("billing_contracts")
      .select("status, cycle, current_period_end, bloqueio_a_partir_de")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw new Error(`ler billing_contracts: ${error.message}`);

    const linha = data as {
      status: string;
      cycle: string | null;
      current_period_end: string | null;
      bloqueio_a_partir_de: string | null;
    } | null;
    if (!linha) return false;

    // A mesma condição de `fn_billing_modo_leitura`: o bloqueio já venceu.
    // `semCarencia`: a pergunta do passo de pagamento. A conta nasce com `bloqueio_a_partir_de = now() + 5 s`
    // (a carência da própria transação de criação), e quem acaba de se cadastrar chega ao roteador do
    // wizard dentro desses 5 s: esperar o bloqueio vencer fazia o "pagar primeiro" concluir o onboarding e
    // entrar no CRM sem pagar (achado na prova pela tela, 15/10/2026). Quem decide é o contrato sem plano.
    const bloqueioVale =
      opcoes.semCarencia === true ||
      (linha.bloqueio_a_partir_de !== null && new Date(linha.bloqueio_a_partir_de).getTime() <= Date.now());
    return (
      bloqueioVale &&
      contratoSemPlano({ status: linha.status, currentPeriodEnd: linha.current_period_end, cycle: linha.cycle })
    );
  } catch (err) {
    logger.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "organizacao_sem_plano",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}

/** O marcador que o cadastro do próprio visitante grava em `organizations.settings` (`lib/auth/provision.ts`). */
export const MARCADOR_SEM_PLANO = "sem_plano";

export type LeituraDeSemPlano = { ok: true; semPlano: boolean } | { ok: false; detalhe: string };

/**
 * "Esta organização NUNCA assinou?" — a pergunta do passo de pagamento do wizard, que NÃO depende
 * do modo de cobrança (`billing_settings.modo`) nem da carência de 5 s da criação: a conta nasceu do
 * cadastro do próprio visitante (marcador `settings.billing_inicio = 'sem_plano'`) E o contrato
 * continua suspenso, sem período e sem ciclo. Com a compra pelo cliente ligada, quem está nesse
 * estado paga antes de configurar, mesmo numa instalação em `avisar`.
 *
 * Diferente de `organizacaoSemPlano`, NÃO é fail-open: uma leitura que falha devolve
 * `{ ok: false }` e quem chama decide (o roteador do wizard não conclui o onboarding sem saber).
 * Nunca lança.
 */
export async function lerSeNuncaAssinou(admin: SupabaseClient, organizationId: string): Promise<LeituraDeSemPlano> {
  try {
    const { data: org, error: erroOrg } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (erroOrg) throw new Error(`ler organizations.settings: ${erroOrg.message}`);
    const marcador = (org as { settings?: { billing_inicio?: unknown } | null } | null)?.settings?.billing_inicio;
    if (marcador !== MARCADOR_SEM_PLANO) return { ok: true, semPlano: false };

    const { data, error } = await admin
      .from("billing_contracts")
      .select("status, cycle, current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw new Error(`ler billing_contracts: ${error.message}`);
    const linha = data as { status: string; cycle: string | null; current_period_end: string | null } | null;
    return {
      ok: true,
      semPlano: contratoSemPlano(linha ? { status: linha.status, currentPeriodEnd: linha.current_period_end, cycle: linha.cycle } : null),
    };
  } catch (err) {
    const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error("alarme_planos_leitura", { organization_id: organizationId, etapa: "ler_se_nunca_assinou", error: detalhe });
    return { ok: false, detalhe };
  }
}

/**
 * O destino da guarda de página: `null` quando o usuário pode seguir, ou o caminho da assinatura
 * quando a organização está sem plano e o `pathname` não é um dos livres. Caminho livre sai antes
 * de qualquer consulta (e é o que impede o laço: o destino é, ele mesmo, um caminho livre).
 * `pathname` vazio (cabeçalho ausente) não decide nada.
 */
export async function destinoDaGuardaSemPlano(
  admin: SupabaseClient,
  organizationId: string,
  pathname: string,
): Promise<string | null> {
  if (!pathname || caminhoLivreSemPlano(pathname)) return null;
  return (await organizacaoSemPlano(admin, organizationId)) ? CAMINHO_DA_ASSINATURA : null;
}
