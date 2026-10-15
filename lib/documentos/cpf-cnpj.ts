/**
 * CPF/CNPJ: máscara de digitação e validação por dígito verificador. Função pura, sem `server-only`:
 * o MESMO código roda no formulário do pagador (navegador) e na action de compra (servidor), para o
 * navegador nunca aceitar o que o servidor recusa.
 */

/** Teto de dígitos de um documento: o CNPJ. */
export const MAXIMO_DE_DIGITOS_DO_DOCUMENTO = 14;

export const MENSAGEM_CPF_INVALIDO = "CPF inválido";
export const MENSAGEM_CNPJ_INVALIDO = "CNPJ inválido";
export const MENSAGEM_DOCUMENTO_INCOMPLETO = "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)";

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

function todosIguais(digitos: string): boolean {
  return /^(\d)\1*$/.test(digitos);
}

/** Módulo 11 do CPF: pesos de `ate+1` até 2, resto*10 mod 11, 10 vira 0. */
function digitoVerificadorCpf(digitos: string, ate: number): number {
  let soma = 0;
  let peso = ate + 1;
  for (let i = 0; i < ate; i++) {
    soma += Number(digitos[i]) * peso;
    peso -= 1;
  }
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

export function cpfValido(valor: string): boolean {
  const digitos = somenteDigitos(valor);
  if (digitos.length !== 11) return false;
  // 000.000.000-00, 111.111.111-11 etc. têm dígito verificador matematicamente
  // "válido" pelo algoritmo e são o erro de digitação mais comum.
  if (todosIguais(digitos)) return false;
  if (digitoVerificadorCpf(digitos, 9) !== Number(digitos[9])) return false;
  return digitoVerificadorCpf(digitos, 10) === Number(digitos[10]);
}

const PESOS_CNPJ_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoVerificadorCnpj(digitos: string, pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < pesos.length; i++) {
    soma += Number(digitos[i]) * pesos[i]!;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor: string): boolean {
  const digitos = somenteDigitos(valor);
  if (digitos.length !== 14) return false;
  if (todosIguais(digitos)) return false;
  const dv1 = digitoVerificadorCnpj(digitos, PESOS_CNPJ_DV1);
  if (dv1 !== Number(digitos[12])) return false;
  const dv2 = digitoVerificadorCnpj(digitos.slice(0, 12) + String(dv1), PESOS_CNPJ_DV2);
  return dv2 === Number(digitos[13]);
}

/** CPF (11 dígitos) ou CNPJ (14 dígitos); qualquer outro comprimento é inválido. */
export function documentoValido(valor: string): boolean {
  const digitos = somenteDigitos(valor);
  if (digitos.length === 11) return cpfValido(digitos);
  if (digitos.length === 14) return cnpjValido(digitos);
  return false;
}

/**
 * Máscara progressiva, enquanto a pessoa digita ou cola. Até 11 dígitos é CPF (000.000.000-00); do 12º ao
 * 14º vira CNPJ (00.000.000/0000-00). Nunca passa de 14 dígitos; aceita valor cru ou já formatado.
 */
export function formatarDocumento(valor: string): string {
  const d = somenteDigitos(valor).slice(0, MAXIMO_DE_DIGITOS_DO_DOCUMENTO);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
  }
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3/$4")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, "$1.$2.$3/$4-$5");
}

/**
 * A mensagem que explica por que o documento não serve, ou `null` quando serve. Com `exigirCompleto`
 * falso (digitação em curso) um documento ainda sem 11 ou 14 dígitos não é erro; completo e errado é.
 */
export function erroDoDocumento(valor: string, exigirCompleto = true): string | null {
  const digitos = somenteDigitos(valor);
  if (digitos.length === 11) return cpfValido(digitos) ? null : MENSAGEM_CPF_INVALIDO;
  if (digitos.length === 14) return cnpjValido(digitos) ? null : MENSAGEM_CNPJ_INVALIDO;
  return exigirCompleto ? MENSAGEM_DOCUMENTO_INCOMPLETO : null;
}
