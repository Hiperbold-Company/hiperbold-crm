/**
 * A CHAVE DO JEV DA INSTALAÇÃO — a reserva de quem não cadastrou a própria.
 *
 * Só servidor: lê o ambiente. Arquivos de cliente (cartão, lista de credenciais)
 * importam `./credencial`, que não toca em `env`.
 *
 * Ordem de quem manda a pergunta ao fornecedor (`resolverChaveDoJev`, `./ponto`):
 * a credencial `typesafe` ativa e validada da organização, depois ESTA, depois
 * nada (o caminho de sempre, sem requisição). A chave nunca é impressa nem
 * devolvida por rota — quem pergunta "há chave?" recebe um booleano.
 */
import { env } from "@/lib/env";

/** `JEV_API_KEY` aparada, ou `null` quando vazia (= sem reserva da instalação). */
export function chaveDaInstalacaoDoJev(): string | null {
  const chave = (env.JEV_API_KEY ?? "").trim();
  return chave === "" ? null : chave;
}
