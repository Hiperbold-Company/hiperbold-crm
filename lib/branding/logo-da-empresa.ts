/**
 * A logo da EMPRESA como avatar — o círculo do seletor de organizações.
 *
 * ── Por que não é a marca ─────────────────────────────────────────────────────
 *
 * O arquivo é o MESMO `settings.branding.logo_path` que a tela Marca grava, mas a
 * pergunta é outra. A marca (`resolverMarcaDaOrganizacao`) decide como o PRODUTO
 * se apresenta, e só deixa a camada da organização entrar com o módulo
 * `marca_por_organizacao` ligado. O avatar só identifica QUAL empresa é qual no
 * seletor, e por isso vale para toda organização, com ou sem o módulo. Este
 * resolvedor não consulta o módulo de propósito; quem precisa da marca continua
 * chamando `resolverMarcaDaOrganizacao`.
 *
 * ── Por que confere o prefixo ─────────────────────────────────────────────────
 *
 * Quem grava é `fn_definir_logo_por_tema_da_organizacao`, que assevera o prefixo
 * dentro do banco. Um `settings` escrito à mão, porém, poderia apontar para o
 * arquivo de outra empresa ou da instalação; aqui ele vira `null`, e o seletor
 * mostra as iniciais em vez da logo alheia.
 *
 * ── Por que NUNCA lança ───────────────────────────────────────────────────────
 *
 * Roda dentro de `lerPermissoes` (`lib/auth/server.ts`), que alimenta toda tela
 * de `/app`. Uma exceção aqui seria a sessão inteira em erro por causa de um
 * círculo de 32px.
 */

import { baseDoStorage, caminhoBateComPrefixo, prefixoDaOrganizacao, urlPublicaDoLogo } from "./logo";

/**
 * A URL pública da logo da empresa, ou `null` quando ela não tem uma utilizável.
 *
 * Mesma forma de URL da marca (`urlPublicaDoLogo`, bucket `brand-logos`): nada de
 * bucket novo nem de assinatura.
 */
export function logoDaEmpresa(
  organizationId: string,
  caminho: unknown,
  base: string = baseDoStorage(),
): string | null {
  try {
    if (typeof organizationId !== "string" || organizationId.length === 0) return null;
    if (typeof caminho !== "string") return null;
    const limpo = caminho.trim();
    if (limpo.length === 0) return null;
    if (!caminhoBateComPrefixo(limpo, prefixoDaOrganizacao(organizationId))) return null;
    const baseLimpa = (base ?? "").trim();
    if (baseLimpa.length === 0) return null;
    return urlPublicaDoLogo(limpo, baseLimpa);
  } catch {
    return null;
  }
}
