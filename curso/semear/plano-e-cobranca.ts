/**
 * Semente do módulo "Meu plano" (Configurações › Meu plano, `/app/settings/plano`).
 *
 * Hiperbold: a lição do upstream ensinava `/app/settings/billing` (a cobrança do
 * revendedor, `cobranca_planos`/`cobranca_assinaturas`). No fork esse endereço só
 * redireciona para "Meu plano", que lê os planos próprios da Hiperbold:
 * `billing_plans` (catálogo semeado pelo baseline: Ilimitado, Pro, Max, Escale) e
 * `billing_contracts` (uma linha por organização). Aqui a Clínica Bem Viver fica
 * EM DIA no plano Pro, mensal, com o período começando há 10 dias e terminando
 * daqui a 20: o estado em que a tela mostra o selo "Em dia", o próximo
 * vencimento e cada item do plano contra o limite.
 *
 * O fim do período é sempre 00:00 em São Paulo (migração 0908): a tela mostra
 * o último dia do período, um dia antes dele.
 *
 * Nenhum botão das lições confirma nada e nenhum gateway é chamado: o contrato
 * fica sem `gateway` e sem `asaas_subscription_id`.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const DIA = 24 * 60 * 60_000;
/** Meia-noite de São Paulo (UTC-3, sem horário de verão) do dia que está `dias` à frente de hoje. */
function meiaNoiteEmSaoPaulo(dias: number): string {
  const alvo = new Date(Date.now() + dias * DIA - 3 * 60 * 60_000);
  return `${alvo.toISOString().slice(0, 10)}T03:00:00.000Z`;
}

export async function semear(c: Contexto) {
  const { db, org } = c;
  const plano = exigir(
    await db.from("billing_plans").select("id").eq("code", "pro").eq("active", true).maybeSingle(),
    "plano Pro do catálogo",
  ) as { id: string };
  semErro(
    await db.from("billing_contracts").upsert(
      {
        organization_id: org,
        plan_id: plano.id,
        status: "ativa",
        cycle: "monthly",
        gateway: null,
        current_period_start: meiaNoiteEmSaoPaulo(-10),
        current_period_end: meiaNoiteEmSaoPaulo(20),
        cancel_at_period_end: false,
        asaas_subscription_id: null,
      },
      { onConflict: "organization_id" },
    ),
    "contrato da Clínica Bem Viver",
  );
}
