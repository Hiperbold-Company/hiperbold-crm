/**
 * Para onde o Asaas devolve o cliente depois de pagar no cartão (`callback.successUrl`).
 *
 * O Asaas manda o NAVEGADOR de volta numa navegação vinda de outro site, e o cookie de sessão é
 * `sameSite: "strict"`: nesta navegação ele não viaja, o `proxy` não vê sessão e a pessoa cai em `/login`
 * mesmo tendo acabado de pagar. Por isso o `successUrl` NÃO aponta para a tela autenticada e sim para uma
 * página pública e inerte (`/voltar-do-pagamento?para=...`), que devolve um documento do nosso próprio
 * origin; a navegação seguinte parte dele (initiator same-site) e leva o cookie.
 *
 *  - `para=onboarding` (cliente novo, ainda no passo de pagamento): `/onboarding/plano`.
 *  - `para=plano` (quem já usa o CRM e assina ou renova): `/app/settings/plano`.
 *
 * O destino final sai de uma LISTA FIXA (`destinoDoRetornoDoCartao`): qualquer outro valor cai em
 * `/onboarding/plano`. Nada do navegador vira URL, então não há redirecionamento aberto.
 *
 * A URL é montada SÓ de `NEXT_PUBLIC_APP_URL` (configuração do servidor) e dos valores fixos acima.
 * Devolve `undefined` quando a base não é uma URL http(s) válida ou passa de 255 caracteres (limite do
 * Asaas): a compra segue sem retorno.
 */
export const CAMINHO_DA_VOLTA_DO_PAGAMENTO = "/voltar-do-pagamento";
export const CAMINHO_DE_RETORNO_NO_ONBOARDING = "/onboarding/plano";
export const CAMINHO_DE_RETORNO_NO_APP = "/app/settings/plano";

const DESTINOS_DA_VOLTA: Readonly<Record<"onboarding" | "plano", string>> = {
  onboarding: CAMINHO_DE_RETORNO_NO_ONBOARDING,
  plano: CAMINHO_DE_RETORNO_NO_APP,
};

/** `para` da query → caminho interno. Só as duas chaves da lista; o resto vira o passo do onboarding. */
export function destinoDoRetornoDoCartao(para: string | null | undefined): string {
  if (para === "plano") return DESTINOS_DA_VOLTA.plano;
  return DESTINOS_DA_VOLTA.onboarding;
}

export function urlDeRetornoDoCartao(appUrl: string, pagandoNoOnboarding: boolean): string | undefined {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    return undefined;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return undefined;
  const url = `${base.origin}${CAMINHO_DA_VOLTA_DO_PAGAMENTO}?para=${pagandoNoOnboarding ? "onboarding" : "plano"}`;
  return url.length <= 255 ? url : undefined;
}
