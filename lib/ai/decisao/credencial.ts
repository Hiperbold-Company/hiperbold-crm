/**
 * QUAL CHAVE O JEV USA — a regra, sobre linhas já lidas.
 *
 * `chaveDaOrganizacao` (`./ponto.ts`) aplica esta mesma regra em SQL para
 * decifrar a chave. As telas e as rotas precisam da LINHA (rótulo, erro de
 * validação), não do segredo, e é aqui que elas perguntam — uma cópia da regra
 * por leitor é como "a chave que o cartão mostra" e "a chave que sai para a
 * rede" passam a ser duas.
 */
import type { IDS_DE_PROVEDOR_DE_DECISAO } from "@/lib/ai/pontos/provedores";

export const PROVEDOR_DO_JEV = "typesafe" satisfies (typeof IDS_DE_PROVEDOR_DE_DECISAO)[number];

export interface LinhaDeCredencial {
  provider: string;
  is_active: boolean;
  validated_at: string | null;
  created_at: string;
}

/**
 * A credencial do provedor do Jev, ativa e validada, mais recente. Chave colada
 * e ainda não conferida não conta: ela não sai para a rede.
 */
export function credencialEmUsoPeloJev<T extends LinhaDeCredencial>(linhas: readonly T[]): T | null {
  const aptas = linhas.filter(
    (c) => c.provider === PROVEDOR_DO_JEV && c.is_active && c.validated_at !== null,
  );
  return aptas.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

/**
 * De QUEM é a chave que paga a chamada — o mesmo vocabulário de
 * `llm_calls.origem_da_chave` (0906).
 */
export type OrigemDaChaveDoJev = "credencial_da_organizacao" | "chave_da_instalacao";

/**
 * O que se GRAVA em `llm_calls.origem_da_chave` por uma chamada do Jev (migration
 * 0960). A chave da instalação (`JEV_API_KEY`) vira `jev_da_instalacao`, e NÃO
 * `chave_da_instalacao`: este último é a chave de LLM que a Hiperbold paga e que
 * debita a carteira de tokens do plano; o Jev não debita (decisão do dono,
 * 16/10/2026), mas continua medível por esta origem própria.
 */
export type OrigemGravadaDoJev = "credencial_da_organizacao" | "jev_da_instalacao";

export function origemGravadaDoJev(origem: OrigemDaChaveDoJev): OrigemGravadaDoJev {
  return origem === "chave_da_instalacao" ? "jev_da_instalacao" : "credencial_da_organizacao";
}

export type FonteDaChaveDoJev<T extends LinhaDeCredencial = LinhaDeCredencial> =
  | { origem: "credencial_da_organizacao"; credencial: T }
  | { origem: "chave_da_instalacao"; credencial: null };

/**
 * A chave que o Jev usa, na ORDEM de `resolverChaveDoJev` (`./ponto.ts`): a
 * credencial própria da organização (ativa e validada) vence; sem ela vale a da
 * instalação (`JEV_API_KEY`), se houver; sem as duas, `null`. Pura: quem chama
 * diz se a instalação tem chave (`chaveDaInstalacaoDoJev() !== null`), de modo
 * que este arquivo continua seguro para o navegador.
 *
 * `credencialEmUsoPeloJev` segue respondendo só pela LINHA da organização (é
 * ela que tem rótulo e erro de validação para a tela); esta responde "de quem
 * é a chave que sai para a rede".
 */
export function fonteDaChaveDoJev<T extends LinhaDeCredencial>(
  linhas: readonly T[],
  instalacaoTemChave: boolean,
): FonteDaChaveDoJev<T> | null {
  const propria = credencialEmUsoPeloJev(linhas);
  if (propria) return { origem: "credencial_da_organizacao", credencial: propria };
  if (instalacaoTemChave) return { origem: "chave_da_instalacao", credencial: null };
  return null;
}
