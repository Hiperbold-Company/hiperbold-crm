import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { destinoDoRetornoDoCartao } from "@/lib/billing/asaas/retorno-do-cartao";
import { marcaDaSaida } from "@/lib/branding/saida";

// A volta do cartão (Asaas `callback.successUrl`) chega numa navegação vinda de outro site, onde o cookie de
// sessão `SameSite=Strict` não viaja. Este documento é do nosso origin e segue sozinho para a tela
// autenticada: a mesma ponte de `app/auth/social-return`, já provada em produção para o mesmo problema.
// O destino sai de uma lista fixa (`destinoDoRetornoDoCartao`): o valor de `para` nunca é refletido.
export async function GET(request: Request) {
  const destino = destinoDoRetornoDoCartao(new URL(request.url).searchParams.get("para"));
  const marca = await marcaDaSaida(null);
  return respostaDePonte(destino, marca.nome, "Pagamento recebido, voltando para o CRM…");
}
