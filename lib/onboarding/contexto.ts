/**
 * O contexto que decide QUAIS passos do wizard existem nesta instalação e para esta organização
 * (`ContextoDoPasso`, `lib/onboarding/passos.ts`), montado num lugar só para o roteador, o layout
 * e a tela final nunca divergirem — e a guarda dos passos de configuração.
 */
import { redirect } from "next/navigation";

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import type { ContextoDoPasso } from "./passos";
import { compraPeloClienteDisponivel, precisaPagarAntesDeConfigurar, situacaoDoPagamento } from "./precisa-pagar";

/** Caminho do passo de pagamento: para onde a guarda devolve quem tenta pular. */
export const CAMINHO_DO_PASSO_PLANO = "/onboarding/plano";

export async function contextoDoOnboarding(organizationId: string): Promise<ContextoDoPasso> {
  return (await contextoDoOnboardingComLeitura(organizationId)).ctx;
}

/**
 * O contexto + se a leitura do pagamento FALHOU. O roteador (`app/onboarding/page.tsx`) precisa do
 * segundo dado: ele conclui o onboarding quando "não falta passo", e leitura que falhou parece
 * "não falta passo". O indicador e o resumo seguem com o contexto sozinho.
 */
export async function contextoDoOnboardingComLeitura(
  organizationId: string,
): Promise<{ ctx: ContextoDoPasso; leituraFalhou: boolean }> {
  const admin = createAdminClient();
  // A compra ligada decide o caminho ("paga primeiro"); a organização que nunca assinou decide se o passo de
  // pagamento ainda existe (a conjunção é a de `situacaoDoPagamento`, independente do modo de cobrança).
  const pagarPrimeiro = await compraPeloClienteDisponivel(admin);
  let precisaPagar = false;
  let leituraFalhou = false;
  if (pagarPrimeiro) {
    const r = await situacaoDoPagamento(admin, organizationId);
    precisaPagar = r.precisaPagar;
    leituraFalhou = r.leituraFalhou;
  }
  return { ctx: { lojaLigada: env.NUVEMSHOP_ENABLED, precisaPagar, pagarPrimeiro }, leituraFalhou };
}

/**
 * Guarda de PÁGINA dos passos depois do "Plano": enquanto o pagamento é exigido, a URL não abre
 * (volta para o passo de pagamento). As server actions têm a guarda própria em
 * `requireOnboardingCtx` — esta aqui só cuida de quem digita o endereço.
 */
export async function exigirPlanoPagoParaSeguir(organizationId: string): Promise<void> {
  if (await precisaPagarAntesDeConfigurar(createAdminClient(), organizationId)) {
    redirect(CAMINHO_DO_PASSO_PLANO);
  }
}
