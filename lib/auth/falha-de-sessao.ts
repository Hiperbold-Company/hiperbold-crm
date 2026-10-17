/**
 * Falha da SESSÃO ao conferir o segundo fator, vista pela server action.
 *
 * `requirePlatformAdmin` e `isMfaEnrolled` LANÇAM quando o GoTrue não responde ou o `listFactors`
 * volta com erro (falha fechado: leitura que não aconteceu não vira "sem fator"). Numa server action,
 * exceção em produção chega ao navegador como um digest opaco ("An error occurred in the Server
 * Components render") e a pessoa fica sem saber o que fazer. O mais comum é a sessão ter expirado
 * ou perdido o segundo fator: a saída é sair e entrar de novo.
 *
 * Aqui só se RECONHECE esse erro e se dá a frase; a recusa continua sendo recusa (nada é gravado).
 */

export const ERRO_SESSAO_INVALIDA = "sessao_invalida";

export const MENSAGEM_SESSAO_INVALIDA =
  "Sua sessão precisa ser confirmada de novo. Saia e entre com o código de verificação.";

/** Erro do auth-js (`AuthError` e filhos): marcado com `__isAuthError` e nome `Auth…`. */
export function ehFalhaDaSessao(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { __isAuthError?: unknown; name?: unknown };
  return e.__isAuthError === true || (typeof e.name === "string" && /^Auth/.test(e.name));
}
