/**
 * PERMISSÕES POR PERFIL — o resolvedor e a validação.
 *
 * Mora em `organizations.settings.permissoes`, como `{ [chave]: Role[] }`, e SÓ
 * com o que difere do padrão: ausente = padrão. Quem lê passa sempre por
 * `resolverPermissoes` — nunca o jsonb cru (anti-pattern 6 do CLAUDE.md).
 *
 * O resolvedor NUNCA lança: valor inválido, chave desconhecida, papel fora do
 * `liberavel` ou lixo de qualquer forma caem no padrão daquela capacidade. É o
 * que faz uma linha estragada no banco degradar para "como era antes", e não
 * para uma tela de erro.
 *
 * Sem import de servidor: a tela usa este mesmo arquivo.
 */
import { z } from "zod";

import type { Role } from "@/lib/auth/types";

import {
  CAPACIDADES,
  CHAVES_DE_PERMISSAO,
  PAPEIS_CONFIGURAVEIS,
  capacidade,
  ehChaveDePermissao,
  type ChaveDePermissao,
  type PapelConfiguravel,
} from "./catalogo";

/** Toda capacidade com o conjunto EFETIVO de perfis que a têm (admin à parte). */
export type PermissoesResolvidas = Readonly<Record<ChaveDePermissao, readonly PapelConfiguravel[]>>;

function ordenar(papeis: Iterable<PapelConfiguravel>): PapelConfiguravel[] {
  const conjunto = new Set(papeis);
  return PAPEIS_CONFIGURAVEIS.filter((p) => conjunto.has(p));
}

export function permissoesPadrao(): PermissoesResolvidas {
  return Object.fromEntries(
    CAPACIDADES.map((c) => [c.chave, ordenar(c.padrao)]),
  ) as unknown as PermissoesResolvidas;
}

/** Um valor de capacidade é válido se for lista de perfis configuráveis, todos dentro do `liberavel`. */
function papeisValidos(chave: ChaveDePermissao, valor: unknown): PapelConfiguravel[] | null {
  if (!Array.isArray(valor)) return null;
  const liberavel = new Set<string>(capacidade(chave).liberavel);
  for (const papel of valor) {
    if (typeof papel !== "string" || !liberavel.has(papel)) return null;
  }
  return ordenar(valor as PapelConfiguravel[]);
}

/** Lê `settings.permissoes` (qualquer forma) e devolve o efetivo. Nunca lança. */
export function resolverPermissoes(cru: unknown): PermissoesResolvidas {
  const resultado: Record<string, readonly PapelConfiguravel[]> = { ...permissoesPadrao() };
  if (!cru || typeof cru !== "object" || Array.isArray(cru))
    return resultado as PermissoesResolvidas;
  for (const [chave, valor] of Object.entries(cru as Record<string, unknown>)) {
    if (!ehChaveDePermissao(chave)) continue;
    const papeis = papeisValidos(chave, valor);
    if (papeis) resultado[chave] = papeis;
  }
  return resultado as PermissoesResolvidas;
}

/**
 * O papel tem a capacidade? `admin` sempre; `ai_operator` nunca (é papel de
 * token de agente, não de pessoa, e esta configuração é sobre pessoas).
 * Sem mapa (contexto que não carregou as permissões) vale o padrão.
 */
export function papelPode(
  papel: Role | null | undefined,
  chave: ChaveDePermissao,
  mapa?: PermissoesResolvidas | null,
): boolean {
  if (papel === "admin") return true;
  if (papel !== "manager" && papel !== "agent" && papel !== "viewer") return false;
  const efetivo = (mapa ?? permissoesPadrao())[chave] ?? capacidade(chave).padrao;
  return efetivo.includes(papel);
}

function mesmoConjunto(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Só o que difere do padrão — é o que se grava. Objeto vazio = tudo no padrão. */
export function diferencasDoPadrao(
  mapa: PermissoesResolvidas,
): Partial<Record<ChaveDePermissao, PapelConfiguravel[]>> {
  const saida: Partial<Record<ChaveDePermissao, PapelConfiguravel[]>> = {};
  for (const c of CAPACIDADES) {
    const efetivo = ordenar(mapa[c.chave] ?? c.padrao);
    if (!mesmoConjunto(efetivo, c.padrao)) saida[c.chave] = efetivo;
  }
  return saida;
}

const papelSchema = z.enum(PAPEIS_CONFIGURAVEIS);

/**
 * O que a tela manda ao salvar: o conjunto desejado por capacidade. Chave
 * desconhecida e papel fora do `liberavel` são RECUSADOS (não ignorados): na
 * entrada, quem mandou errado precisa saber; só a LEITURA degrada.
 * Capacidade ausente no corpo = padrão.
 */
export const permissoesEntradaSchema = z
  .record(z.string(), z.array(papelSchema).max(PAPEIS_CONFIGURAVEIS.length))
  .superRefine((valor, ctx) => {
    for (const [chave, papeis] of Object.entries(valor)) {
      if (!ehChaveDePermissao(chave)) {
        ctx.addIssue({ code: "custom", path: [chave], message: "capacidade_desconhecida" });
        continue;
      }
      const liberavel = new Set<string>(capacidade(chave).liberavel);
      for (const papel of papeis) {
        if (!liberavel.has(papel)) {
          ctx.addIssue({ code: "custom", path: [chave], message: `perfil_nao_liberavel:${papel}` });
        }
      }
    }
  })
  .transform((valor) => resolverPermissoes(valor));

export { CHAVES_DE_PERMISSAO };
