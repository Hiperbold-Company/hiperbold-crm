/**
 * "Esta organização precisa pagar ANTES de configurar o CRM?" — a pergunta do passo "Plano" do
 * wizard (decisão do dono do produto em 15/10/2026: o cliente novo paga primeiro).
 *
 * ─── A resposta ─────────────────────────────────────────────────────────────
 *
 *  1. a compra pelo cliente está LIGADA (`compraLigada`: `ASAAS_ENABLED` E
 *     `billing_settings.compra_pelo_cliente`) — a mesma conferência que a tela
 *     `/app/settings/plano/assinar` faz antes de mostrar o formulário;
 *  2. a organização NUNCA ASSINOU (`lerSeNuncaAssinou`): nasceu do cadastro do próprio visitante
 *     (marcador `billing_inicio = "sem_plano"`) e o contrato segue suspenso, sem período e sem ciclo.
 *
 * ─── Não depende do modo de cobrança ────────────────────────────────────────
 *
 * Com a compra ligada, o cliente novo paga antes de configurar em QUALQUER `billing_settings.modo`
 * (`avisar`, `bloquear`) e sem a carência de 5 s da criação. O layout de `/app` (organização JÁ
 * concluída) continua dependendo do modo (`organizacaoSemPlano`): lá, `avisar` ainda não cobra.
 * Quem tem contrato ativo, plano liberado pelo admin da plataforma (Ilimitado, sem o marcador) ou
 * suspensão por falta de pagamento (tem período) segue direto. Compra desligada não prende ninguém
 * num passo que não tem como cumprir: o passo some.
 *
 * ─── Fail-open nas guardas, fail-closed para CONCLUIR ───────────────────────
 *
 * As guardas de página e de action (`precisaPagarAntesDeConfigurar`) seguem fail-open: devolvem
 * `false` quando a leitura falha — quem barra o uso de verdade é o banco (modo leitura). Já o
 * roteador do wizard, que CONCLUI o onboarding, usa `situacaoDoPagamento`, que separa "não precisa"
 * de "não consegui ler": ele não conclui sem saber. Nenhuma das duas lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { compraLigada, configDoAsaas } from "@/lib/billing/asaas/config";
import { lerSeNuncaAssinou } from "@/lib/billing/assinatura/sem-plano";

/** A compra pelo próprio cliente está disponível nesta instalação? Nunca lança. */
export async function compraPeloClienteDisponivel(admin: SupabaseClient): Promise<boolean> {
  try {
    const config = configDoAsaas();
    return await compraLigada(admin, config.habilitado);
  } catch {
    // `ErroConfiguracaoAsaas` (base/chave incoerentes) ou env ausente: a compra não abre.
    return false;
  }
}

export interface SituacaoDoPagamento {
  /** Precisa pagar antes de configurar (só verdadeiro com a leitura bem-sucedida). */
  precisaPagar: boolean;
  /** A leitura do contrato falhou: o chamador que CONCLUI algo não pode assumir "pagou". */
  leituraFalhou: boolean;
}

/** Como `precisaPagarAntesDeConfigurar`, mas distingue "não precisa" de "não consegui ler". Nunca lança. */
export async function situacaoDoPagamento(admin: SupabaseClient, organizationId: string): Promise<SituacaoDoPagamento> {
  try {
    if (!(await compraPeloClienteDisponivel(admin))) return { precisaPagar: false, leituraFalhou: false };
    const r = await lerSeNuncaAssinou(admin, organizationId);
    if (!r.ok) return { precisaPagar: false, leituraFalhou: true };
    return { precisaPagar: r.semPlano, leituraFalhou: false };
  } catch {
    return { precisaPagar: false, leituraFalhou: true };
  }
}

/** O cliente precisa pagar o plano antes de seguir para os passos de configuração? Nunca lança (fail-open). */
export async function precisaPagarAntesDeConfigurar(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  return (await situacaoDoPagamento(admin, organizationId)).precisaPagar;
}
