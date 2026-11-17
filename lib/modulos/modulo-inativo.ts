/**
 * `modulo_inativo` (errcode PT423, migration 1016): a RPC de um módulo de tabela recusou porque o
 * módulo está desligado (ou suspenso) na instalação. A rota responde 404, a mesma resposta que dá
 * quando o próprio app já vê o módulo desligado: para quem chama, a funcionalidade não existe agora.
 */
export const ERRCODE_MODULO_INATIVO = "PT423";

export function moduloInativo(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === ERRCODE_MODULO_INATIVO;
}
