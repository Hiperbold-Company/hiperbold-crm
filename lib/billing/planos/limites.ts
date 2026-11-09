/**
 * O conjunto fechado de chaves de limite do plano.
 *
 * A lista, o teto e a validação espelham `fn_billing_limites_validos`: a
 * versão da migration `20260923020000_0904_planos_de_assinatura.sql` (as sete
 * chaves originais) e a da `20261109130000_1001_planos_v2_limites_novos.sql`
 * (D-227, as seis chaves novas). Chave nova exige migração que a acrescente
 * à função, e item novo de limite sempre exige código de contagem ou de trava.
 *
 * ═══ Dois conjuntos aceitos, nunca um meio-termo ═══
 *
 * Um plano grava OU as sete chaves de antes (versão 1 dos planos e qualquer
 * clone que ainda não ganhou a versão 2) OU as treze. Chave das seis novas
 * AUSENTE na linha do plano quer dizer "sem limite": é o que mantém contrato
 * na versão 1 sem os limites novos até a renovação. Por isso o esquema do
 * plano NORMALIZA: aceita os dois conjuntos e devolve sempre as treze chaves,
 * com `null` no que faltou. Quem lê `Limites` nunca precisa saber de onde veio.
 *
 * O que NÃO está aqui, de propósito: a precedência entre plano e ajuste. Ela
 * mora em UMA função SQL, `fn_billing_limites_efetivos`, chamada por RPC
 * (`plano-da-organizacao.ts`). Os helpers de leitura do fim deste arquivo só
 * LEEM o resultado dela, nunca refazem a conta.
 */
import { z } from "zod";

/** As sete chaves originais (0904), na ordem da migration e da tabela semeada. */
export const CHAVES_DE_LIMITE_ORIGINAIS = [
  "funis",
  "etapas_por_funil",
  "leads",
  "membros",
  "conexoes",
  "integracoes_webhook",
  "tokens_ia_mes",
] as const;

/**
 * As seis chaves da versão 2 dos planos (1001, D-227).
 *
 * - `agentes_ia`: quantos agentes de IA não arquivados a organização pode ter.
 * - `automacoes`: quantas automações (regras) a organização pode ter.
 * - `mcp_req_min`: requisições por minuto no MCP; 0 = o plano não inclui MCP.
 * - `acesso_api`: 0 ou 1; 0 = o plano não inclui chave de API (`dsk_`).
 * - `automacao_comentario_instagram`: 0 ou 1; 0 = não inclui automação por
 *   comentário do Instagram.
 * - `fonte_dados_req_min`: requisições por minuto aceitas em cada fonte de
 *   dados (webhook de entrada).
 */
export const CHAVES_DE_LIMITE_NOVAS = [
  "agentes_ia",
  "automacoes",
  "mcp_req_min",
  "acesso_api",
  "automacao_comentario_instagram",
  "fonte_dados_req_min",
] as const;

/** As treze chaves, originais primeiro. É a forma de todo `Limites` lido. */
export const CHAVES_DE_LIMITE = [...CHAVES_DE_LIMITE_ORIGINAIS, ...CHAVES_DE_LIMITE_NOVAS] as const;

export type ChaveDeLimite = (typeof CHAVES_DE_LIMITE)[number];
export type ChaveDeLimiteOriginal = (typeof CHAVES_DE_LIMITE_ORIGINAIS)[number];
export type ChaveDeLimiteNova = (typeof CHAVES_DE_LIMITE_NOVAS)[number];

/** As chaves que só aceitam 0 (não incluso), 1 (incluso) ou `null` (sem limite). */
export const CHAVES_DE_LIMITE_LIGA_DESLIGA: readonly ChaveDeLimite[] = [
  "acesso_api",
  "automacao_comentario_instagram",
];

/** Cada chave: um inteiro >= 0, ou `null` significando sem limite. */
export type Limites = Record<ChaveDeLimite, number | null>;

/** O maior inteiro que a coluna `integer` do Postgres aceita. */
export const TETO_DE_LIMITE = 2147483647;

/** O maior valor aceito numa chave: 1 nas de liga/desliga, `TETO_DE_LIMITE` nas demais. */
export function tetoDaChave(chave: ChaveDeLimite): number {
  return CHAVES_DE_LIMITE_LIGA_DESLIGA.includes(chave) ? 1 : TETO_DE_LIMITE;
}

function esquemaDaChave(chave: ChaveDeLimite) {
  return z.number().int().min(0).max(tetoDaChave(chave)).nullable();
}

type EsquemaDeValor = ReturnType<typeof esquemaDaChave>;

const formaDasOriginais = Object.fromEntries(
  CHAVES_DE_LIMITE_ORIGINAIS.map((chave) => [chave, esquemaDaChave(chave)]),
) as Record<ChaveDeLimiteOriginal, EsquemaDeValor>;

const formaDoObjetoDeLimites = Object.fromEntries(
  CHAVES_DE_LIMITE.map((chave) => [chave, esquemaDaChave(chave)]),
) as Record<ChaveDeLimite, EsquemaDeValor>;

/** O plano no conjunto das sete chaves de antes (versão 1). */
const esquemaDoPlanoOriginal = z.object(formaDasOriginais).strict();

/** O plano no conjunto das treze chaves (versão 2 em diante). */
const esquemaDoPlanoCompleto = z.object(formaDoObjetoDeLimites).strict();

/** Completa as chaves que faltam com `null` (ausente = sem limite). */
export function normalizarLimites(
  parcial: Partial<Record<ChaveDeLimite, number | null>>,
): Limites {
  return Object.fromEntries(
    CHAVES_DE_LIMITE.map((chave) => [chave, parcial[chave] ?? null]),
  ) as Limites;
}

/**
 * O esquema do PLANO: as sete chaves originais OU as treze, nunca um
 * meio-termo. Espelha `fn_billing_limites_validos(limits, parcial := false)`
 * e devolve sempre as treze chaves (as ausentes como `null`).
 */
export const esquemaDoPlanoDeLimites = z
  .union([esquemaDoPlanoCompleto, esquemaDoPlanoOriginal])
  .transform((l): Limites => normalizarLimites(l));

/**
 * O esquema do AJUSTE: qualquer subconjunto das treze chaves, inclusive vazio.
 * Espelha `fn_billing_limites_validos(limits, parcial := true)`.
 */
export const esquemaDoAjusteDeLimites = z.object(formaDoObjetoDeLimites).partial().strict();

export type AjusteDeLimites = z.infer<typeof esquemaDoAjusteDeLimites>;

// ─────────────────────────────────────────────────────────────────────────
// Leitura dos limites EFETIVOS (o ajuste do admin já aplicado pelo banco)
// ─────────────────────────────────────────────────────────────────────────

/** Os recursos que o plano inclui ou não, e a chave de cada um. Valor 0 = não incluso. */
export const CHAVE_DO_RECURSO = {
  mcp: "mcp_req_min",
  api: "acesso_api",
  comentario_instagram: "automacao_comentario_instagram",
} as const satisfies Record<string, ChaveDeLimiteNova>;

export type RecursoDoPlano = keyof typeof CHAVE_DO_RECURSO;

/**
 * O limite de uma chave. Chave ausente (objeto de antes da 1001, ou lido de
 * fora do esquema) vale `null`, que é "sem limite".
 */
export function limiteDaChave(
  limites: Partial<Record<ChaveDeLimite, number | null>>,
  chave: ChaveDeLimite,
): number | null {
  const valor = limites[chave];
  return typeof valor === "number" ? valor : null;
}

/**
 * Se o plano inclui o recurso. Só o valor 0 exclui: `null` (sem limite, ou
 * chave ausente num plano antigo) e qualquer número positivo incluem.
 */
export function recursoIncluidoNosLimites(
  limites: Partial<Record<ChaveDeLimite, number | null>>,
  recurso: RecursoDoPlano,
): boolean {
  return limiteDaChave(limites, CHAVE_DO_RECURSO[recurso]) !== 0;
}
