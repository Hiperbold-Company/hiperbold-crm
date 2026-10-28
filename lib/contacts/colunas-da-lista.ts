/**
 * As colunas da tela de Contatos que cada usuário escolhe ("Personalizar colunas").
 *
 * PURO, e usado pelos dois lados: a tela monta o painel e a tabela a partir daqui, e a rota
 * `PUT /api/v1/contacts/colunas` valida e normaliza a escolha pela MESMA função antes de gravar
 * em `user_preferences` (chave `contatos.colunas`, migration 0978).
 *
 * Regras: "Nome" é sempre a primeira e "ações" sempre a última (não saem); no máximo
 * `MAXIMO_DE_COLUNAS`, contando as duas; campo personalizado do contato entra como `cf:<chave>`,
 * com a mesma régua de chave do filtro e nunca chave de documento (CPF, RG...).
 */
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";

export const CHAVE_DA_PREFERENCIA = "contatos.colunas";
export const MAXIMO_DE_COLUNAS = 12;

/** Colunas do próprio contato, na ordem em que o painel as oferece. */
export const COLUNAS_DO_SISTEMA = [
  { id: "nome", rotulo: "Nome" },
  { id: "email", rotulo: "Email" },
  { id: "telefone", rotulo: "Telefone" },
  { id: "tags", rotulo: "Tags" },
  { id: "ultima_atividade", rotulo: "Última atividade" },
  { id: "status", rotulo: "Status" },
  { id: "entrou_no_crm", rotulo: "Entrou no CRM" },
  { id: "origem", rotulo: "Origem" },
  { id: "aniversario", rotulo: "Aniversário" },
  { id: "ultima_mensagem", rotulo: "Última mensagem" },
  { id: "acoes", rotulo: "Ações" },
] as const;

export type ColunaDoSistema = (typeof COLUNAS_DO_SISTEMA)[number]["id"];

/** As 7 colunas de antes desta feature: quem nunca personalizou vê exatamente a tela de sempre. */
export const COLUNAS_PADRAO: readonly string[] = [
  "nome",
  "email",
  "telefone",
  "tags",
  "ultima_atividade",
  "status",
  "acoes",
];

const FIXA_INICIO = "nome";
const FIXA_FIM = "acoes";
const IDS_DO_SISTEMA = new Set<string>(COLUNAS_DO_SISTEMA.map((c) => c.id));
const CHAVE_DE_CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
export const PREFIXO_DE_CAMPO = "cf:";

/** É uma coluna que a tela sabe mostrar? */
export function colunaValida(id: string): boolean {
  if (IDS_DO_SISTEMA.has(id)) return true;
  if (!id.startsWith(PREFIXO_DE_CAMPO)) return false;
  const chave = id.slice(PREFIXO_DE_CAMPO.length);
  return CHAVE_DE_CAMPO.test(chave) && !chaveSensivelDeCampo(chave);
}

export function ehColunaFixa(id: string): boolean {
  return id === FIXA_INICIO || id === FIXA_FIM;
}

/**
 * A escolha em forma canônica: sem repetição, sem id desconhecido, "Nome" no começo, "ações" no
 * fim e no máximo `MAXIMO_DE_COLUNAS`. Lista ausente ou inválida = o padrão. Serve para ler o que
 * está gravado (um id que deixou de existir some sozinho) e para gravar.
 */
export function normalizarColunas(entrada: unknown): string[] {
  if (!Array.isArray(entrada)) return [...COLUNAS_PADRAO];
  const meio: string[] = [];
  for (const v of entrada) {
    if (typeof v !== "string" || ehColunaFixa(v) || !colunaValida(v) || meio.includes(v)) continue;
    meio.push(v);
  }
  return [FIXA_INICIO, ...meio.slice(0, MAXIMO_DE_COLUNAS - 2), FIXA_FIM];
}

export function ehPadrao(colunas: readonly string[]): boolean {
  return colunas.length === COLUNAS_PADRAO.length && colunas.every((c, i) => c === COLUNAS_PADRAO[i]);
}
