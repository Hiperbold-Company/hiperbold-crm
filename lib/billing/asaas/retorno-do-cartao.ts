/**
 * Para onde o Asaas devolve o cliente depois de pagar no cartão (`callback.successUrl`).
 *
 *  - Cliente novo, ainda no passo de pagamento do onboarding: `/onboarding/plano`. A página confere o
 *    contrato (ou o pedido pendente) e segue sozinha para o CRM.
 *  - Cliente que já usa o CRM e assina ou renova: `/app/settings/plano`.
 *
 * A URL é montada SÓ de `NEXT_PUBLIC_APP_URL` (configuração do servidor) e de dois caminhos fixos:
 * nada vem do navegador, então não há redirecionamento aberto. Devolve `undefined` quando a base não é
 * uma URL http(s) válida ou passa de 255 caracteres (limite do Asaas): a compra segue sem retorno.
 */
export const CAMINHO_DE_RETORNO_NO_ONBOARDING = "/onboarding/plano";
export const CAMINHO_DE_RETORNO_NO_APP = "/app/settings/plano";

export function urlDeRetornoDoCartao(appUrl: string, pagandoNoOnboarding: boolean): string | undefined {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    return undefined;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return undefined;
  const url = `${base.origin}${pagandoNoOnboarding ? CAMINHO_DE_RETORNO_NO_ONBOARDING : CAMINHO_DE_RETORNO_NO_APP}`;
  return url.length <= 255 ? url : undefined;
}
