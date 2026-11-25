/**
 * OS TIPOS DE DOCUMENTO DO CONTATO — para o país em que o titular escolhe qual
 * documento informa (hoje, os Estados Unidos).
 *
 * ─── Por que um seletor, e não "o documento do país" ──────────────────────
 *
 * No Brasil e em Portugal há UM documento do titular (CPF, NIF), e o perfil o
 * declara em `documento`. Nos Estados Unidos não há: a carteira de motorista é
 * estadual, o passaporte é de quem tem, e boa parte dos clientes de Orlando é
 * brasileira e se identifica pelo CPF. Decisão do dono do produto (24/11/2026):
 * "pedir sim um documento, mas ter antes um seletor, para o próprio cliente
 * escolher qual documento quer usar; a lista precisa ser de documentos
 * válidos". O documento continua OPCIONAL; quando vem, vem com o tipo.
 *
 * ─── Por que NÃO há SSN ────────────────────────────────────────────────────
 *
 * O Social Security Number é a chave de fraude de identidade nos EUA, e um CRM
 * de vendas não tem motivo para guardá-lo. Ele não é um tipo oferecido — a API
 * recusa `us_ssn` como qualquer valor fora da lista — e o anonimizador do
 * perfil `US` o REDIGE quando ele aparece numa conversa (padrão `ssn`).
 *
 * ─── O vocabulário mora aqui, e o banco o confere ─────────────────────────
 *
 * `contacts.document_type` (migration 1020) tem CHECK com exatamente
 * `TIPOS_DE_DOCUMENTO_DO_CONTATO`, vigiado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`. A coluna nasceu
 * vazia, sem legado em clone nenhum — por isso o CHECK pode entrar (a exceção
 * de vocabulário aberto do CLAUDE.md é para coluna COM legado).
 *
 * ─── O que cada validador GARANTE ─────────────────────────────────────────
 *
 * Só o CPF confere dígito verificador (o mod-11 de sempre). ITIN confere a
 * forma e as faixas do 4.º/5.º dígitos que o IRS publica; os demais conferem
 * forma. A `regra` de cada tipo diz isso com todas as letras (régua do #928:
 * não se inventa dígito verificador).
 */
import { isValidCpf } from "./cpf";

/** Os valores que `contacts.document_type` aceita. Ordem = ordem do seletor. */
export const TIPOS_DE_DOCUMENTO_DO_CONTATO = [
  "us_drivers_license",
  "us_state_id",
  "us_passport",
  "us_green_card",
  "us_itin",
  "foreign_passport",
  "br_cpf",
] as const;

export type TipoDeDocumentoDoContato = (typeof TIPOS_DE_DOCUMENTO_DO_CONTATO)[number];

export interface TipoDeDocumento {
  codigo: TipoDeDocumentoDoContato;
  /** O rótulo da tela — chave do dicionário (o texto em português). */
  rotulo: string;
  /** Exemplo mostrado no formulário. */
  exemplo: string;
  /** O que a validação GARANTE. */
  regra: string;
  /** A mensagem de erro pronta — chave do dicionário. */
  mensagemInvalido: string;
  /** `true` quando o validador confere dígito verificador, e não só a forma. */
  confereDigito: boolean;
  /** Valida o valor como o usuário digitou. */
  valida(valor: string): boolean;
  /** Como o valor é GRAVADO (cifrado) e entra no hash de busca. */
  normaliza(valor: string): string;
}

/** Tira espaço, ponto, traço e barra; o resto (inclusive letra) fica, em maiúsculas. */
function alfanumerico(valor: string): string {
  return valor.replace(/[\s./-]/g, "").toUpperCase();
}

/** Só os separadores saem — letra sobra e o validador recusa. */
function digitosComSeparador(valor: string): string {
  return valor.replace(/[\s.-]/g, "");
}

/**
 * ITIN: nove dígitos, começa com 9, e o 4.º/5.º dígitos nas faixas 50–65,
 * 70–88, 90–92 e 94–99 — IRM 3.21.263 (IRS), conferido em 2026-11-24. O 89 e
 * o 93 são de outros programas (o 93 é o ATIN, IRM 3.13.40).
 */
export function isValidItin(valor: string): boolean {
  const s = digitosComSeparador(valor);
  if (!/^9\d{8}$/.test(s)) return false;
  const meio = Number(s.slice(3, 5));
  return (
    (meio >= 50 && meio <= 65) ||
    (meio >= 70 && meio <= 88) ||
    (meio >= 90 && meio <= 92) ||
    (meio >= 94 && meio <= 99)
  );
}

/** Passaporte americano: 9 caracteres alfanuméricos (o de 2021+ é letra + 8 dígitos; o antigo, 9 dígitos). */
export function isValidPassaporteAmericano(valor: string): boolean {
  return /^[A-Z0-9]{9}$/.test(alfanumerico(valor));
}

/**
 * Green Card (Permanent Resident Card): o número do cartão, 3 letras + 10
 * dígitos (`ABC1234567890`), ou o A-Number antigo, `A` + 8 ou 9 dígitos.
 */
export function isValidGreenCard(valor: string): boolean {
  const s = alfanumerico(valor);
  return /^[A-Z]{3}\d{10}$/.test(s) || /^A\d{8,9}$/.test(s);
}

/** Carteira de motorista, State ID e passaporte estrangeiro: 4 a 20 letras ou dígitos. */
export function isValidDocumentoLivre(valor: string): boolean {
  if (/[^0-9A-Za-z\s./-]/.test(valor)) return false;
  return /^[A-Z0-9]{4,20}$/.test(alfanumerico(valor));
}

const FORMA_LIVRE = "forma — 4 a 20 letras ou dígitos; não confere dígito verificador";

export const TIPOS_DE_DOCUMENTO: Readonly<Record<TipoDeDocumentoDoContato, TipoDeDocumento>> = {
  us_drivers_license: {
    codigo: "us_drivers_license",
    rotulo: "Carteira de motorista (Driver's License)",
    exemplo: "D12345678",
    regra: FORMA_LIVRE,
    mensagemInvalido: "Carteira de motorista inválida: use de 4 a 20 letras ou dígitos",
    confereDigito: false,
    valida: isValidDocumentoLivre,
    normaliza: alfanumerico,
  },
  us_state_id: {
    codigo: "us_state_id",
    rotulo: "Identidade estadual (State ID)",
    exemplo: "S12345678",
    regra: FORMA_LIVRE,
    mensagemInvalido: "State ID inválido: use de 4 a 20 letras ou dígitos",
    confereDigito: false,
    valida: isValidDocumentoLivre,
    normaliza: alfanumerico,
  },
  us_passport: {
    codigo: "us_passport",
    rotulo: "Passaporte americano (US Passport)",
    exemplo: "A12345678",
    regra: "forma — 9 letras ou dígitos; não confere dígito verificador",
    mensagemInvalido: "Passaporte americano inválido: são 9 letras ou dígitos",
    confereDigito: false,
    valida: isValidPassaporteAmericano,
    normaliza: alfanumerico,
  },
  us_green_card: {
    codigo: "us_green_card",
    rotulo: "Green Card (Permanent Resident Card)",
    exemplo: "ABC1234567890",
    regra: "forma — 3 letras e 10 dígitos, ou A e 8 a 9 dígitos; não confere dígito verificador",
    mensagemInvalido: "Green Card inválido: use 3 letras e 10 dígitos (ABC1234567890) ou A e 8 a 9 dígitos",
    confereDigito: false,
    valida: isValidGreenCard,
    normaliza: alfanumerico,
  },
  us_itin: {
    codigo: "us_itin",
    rotulo: "ITIN",
    exemplo: "912-70-1234",
    regra: "forma e faixas do IRS — começa com 9; não confere dígito verificador",
    mensagemInvalido: "ITIN inválido: 9 dígitos começando com 9, no formato 9XX-XX-XXXX",
    confereDigito: false,
    valida: isValidItin,
    normaliza: (valor) => valor.replace(/\D/g, ""),
  },
  foreign_passport: {
    codigo: "foreign_passport",
    rotulo: "Passaporte estrangeiro",
    exemplo: "FX123456",
    regra: FORMA_LIVRE,
    mensagemInvalido: "Passaporte estrangeiro inválido: use de 4 a 20 letras ou dígitos",
    confereDigito: false,
    valida: isValidDocumentoLivre,
    normaliza: alfanumerico,
  },
  br_cpf: {
    codigo: "br_cpf",
    rotulo: "CPF (Brasil)",
    exemplo: "000.000.000-00",
    regra: "dígito verificador (mod-11 da Receita Federal)",
    mensagemInvalido: "CPF inválido",
    confereDigito: true,
    valida: isValidCpf,
    normaliza: (valor) => valor.replace(/\D/g, ""),
  },
};

/** O tipo pelo código, ou `null` quando o código não é da lista (inclusive `us_ssn`). */
export function tipoDeDocumento(codigo: string | null | undefined): TipoDeDocumento | null {
  if (!codigo) return null;
  return (TIPOS_DE_DOCUMENTO as Record<string, TipoDeDocumento>)[codigo] ?? null;
}

/**
 * Os tipos cujo número é só dígitos e se grava como hoje (o CPF). Para os
 * demais, o HMAC de busca leva o tipo na frente: passaporte e ITIN de pessoas
 * diferentes com os mesmos 9 caracteres não podem colidir no índice único
 * `uniq_contacts_org_cpf`.
 */
export function tipoGravaComoCpf(codigo: string | null | undefined): boolean {
  return !codigo || codigo === "br_cpf";
}
