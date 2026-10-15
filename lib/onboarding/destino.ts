/**
 * Para onde o roteador do wizard (`app/onboarding/page.tsx`) leva, e onde termina o caminho
 * "paga primeiro". Funções PURAS: a decisão mora aqui para ser medida sem montar a página.
 *
 * ─── O caminho "paga primeiro" (compra pelo cliente ligada) ─────────────────
 *
 * Cadastro → pagamento → Início. O wizard se reduz ao passo "Plano" (`passos.ts`): quando ele deixa
 * de existir porque o contrato ficou ativo, não resta passo nenhum e o roteador CONCLUI o
 * onboarding (`onboarded_at`) e entra no CRM pela tela Início, em vez de mostrar a tela "done" (que
 * resume um wizard que esta pessoa não percorreu).
 */
import type { ContextoDoPasso, PassoDoOnboarding } from "./passos";

/** Onde o cliente cai logo depois de pagar. */
export const CAMINHO_DEPOIS_DE_PAGO = "/app/inicio";

/** Onde o wizard manda quem já concluiu, no caminho antigo (compra desligada). */
export const CAMINHO_DEPOIS_DE_CONCLUIDO_ANTIGO = "/app/inbox";

/** Onde o wizard manda quem já concluiu, no caminho novo: a entrada de /app decide entre Início e Inbox. */
export const CAMINHO_DEPOIS_DE_CONCLUIDO = "/app";

export type DestinoDoRoteador =
  /** Ainda há um passo a cumprir. */
  | { tipo: "passo"; caminho: string }
  /** Não falta passo e o caminho é o "paga primeiro": conclui o onboarding e entra no CRM. */
  | { tipo: "concluir"; caminho: string };

export function destinoDoRoteador(
  proximo: Pick<PassoDoOnboarding, "segmento"> | null,
  ctx: Pick<ContextoDoPasso, "pagarPrimeiro">,
): DestinoDoRoteador {
  if (proximo) return { tipo: "passo", caminho: `/onboarding/${proximo.segmento}` };
  if (ctx.pagarPrimeiro) return { tipo: "concluir", caminho: CAMINHO_DEPOIS_DE_PAGO };
  return { tipo: "passo", caminho: "/onboarding/done" };
}

/** Para onde vai quem abre o wizard com a organização já concluída. */
export function destinoSeJaConcluido(pagarPrimeiro: boolean): string {
  return pagarPrimeiro ? CAMINHO_DEPOIS_DE_CONCLUIDO : CAMINHO_DEPOIS_DE_CONCLUIDO_ANTIGO;
}
