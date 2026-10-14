import "server-only";

/**
 * Cupom de desconto na compra do plano (migration 0955, fork Hiperbold).
 *
 * A conta do desconto, a validação e o piso de R$ 5,00 moram no banco (`fn_billing_cupom_resolver`,
 * chamada por `fn_billing_criar_pedido`): este módulo só traduz o que o banco diz para a frase que a tela
 * mostra, e embrulha a simulação (`fn_billing_cupom_simular`). Nada aqui calcula preço: o navegador não
 * manda valor nenhum, só o código.
 */
import { createHmac } from "node:crypto";

import type { CicloPedido, RpcResultado } from "./compra";

/** O mesmo formato do banco (`billing_cupons_codigo_formato`): letras, números, hífen e sublinhado, 3 a 40. */
export const FORMATO_DO_CODIGO_DE_CUPOM = /^[A-Za-z0-9_-]{3,40}$/;

/**
 * Uma frase só para TODA recusa de código que não se aplica a esta compra (inexistente, inativo, expirado,
 * esgotado, fora do plano, fora do ciclo, formato errado): quem tenta adivinhar códigos não descobre, pela
 * resposta, se um código existe nem por que não serve. As distinções ficam no banco e no log.
 */
export const MENSAGEM_CUPOM_INVALIDO = "Cupom inválido ou indisponível para esta compra.";
/** Compatibilidade: os motivos que antes tinham frase própria hoje dão a mesma frase de `MENSAGEM_CUPOM_INVALIDO`. */
export const MENSAGEM_CUPOM_EXPIRADO = MENSAGEM_CUPOM_INVALIDO;
export const MENSAGEM_CUPOM_ESGOTADO = MENSAGEM_CUPOM_INVALIDO;
export const MENSAGEM_CUPOM_NAO_VALE_PARA_O_PLANO = MENSAGEM_CUPOM_INVALIDO;
export const MENSAGEM_CUPOM_NAO_VALE_PARA_O_CICLO = MENSAGEM_CUPOM_INVALIDO;
/** Só quem já usou o cupom (a organização ou o mesmo CPF/CNPJ) sabe disso; não revela nada sobre o código. */
export const MENSAGEM_CUPOM_JA_USADO = "Este cupom já foi utilizado por você ou pela sua organização.";
export const MENSAGEM_CUPOM_SEM_DESCONTO = "Este cupom não dá desconto neste plano.";
export const MENSAGEM_CUPOM_PARCELA_MINIMA = "Com este desconto, escolha menos parcelas.";
export const MENSAGEM_CUPOM_TENTATIVAS = "Muitas tentativas com cupom. Aguarde alguns minutos e tente de novo.";

const MENSAGEM_POR_CODIGO: ReadonlyArray<readonly [string, string]> = [
  ["billing_cupom_ja_usado", MENSAGEM_CUPOM_JA_USADO],
  ["billing_cupom_sem_desconto", MENSAGEM_CUPOM_SEM_DESCONTO],
  ["billing_cupom_parcela_minima", MENSAGEM_CUPOM_PARCELA_MINIMA],
  // expirado, esgotado, nao_vale_para_o_plano e nao_vale_para_o_ciclo caem no prefixo abaixo, de propósito.
  // Por último: é o prefixo de todos, e também o código de inexistente, inativo e fora do formato.
  ["billing_cupom_", MENSAGEM_CUPOM_INVALIDO],
];

/** A frase de um erro de cupom do banco, ou `null` quando o texto não é de cupom (quem chama segue o próprio caminho). */
export function mensagemDoErroDeCupom(texto: string | null | undefined): string | null {
  if (!texto) return null;
  for (const [codigo, mensagem] of MENSAGEM_POR_CODIGO) {
    if (texto.includes(codigo)) return mensagem;
  }
  return null;
}

/**
 * A impressão do CPF/CNPJ do pagador: HMAC-SHA256 (hexadecimal, 64 caracteres) dos dígitos, com a chave do
 * servidor. É só o que vai ao banco (`billing_orders.pagador_impressao`, em pedido com cupom) para o mesmo
 * documento não usar o mesmo cupom duas vezes; o documento em si nunca é gravado (decisão 16 da fase F5) e a
 * impressão não se desfaz sem a chave. Devolve `null` quando não há documento de tamanho válido ou quando o
 * servidor não tem a chave (`CPF_ENCRYPTION_KEY`); nesse caso a regra do pagador simplesmente não vale.
 */
export function impressaoDoPagador(
  documento: string | null | undefined,
  chave: string | undefined = process.env.CPF_ENCRYPTION_KEY,
): string | null {
  const digitos = (documento ?? "").replace(/\D/g, "");
  if (digitos.length !== 11 && digitos.length !== 14) return null;
  const segredo = (chave ?? "").trim();
  if (segredo === "") return null;
  return createHmac("sha256", `hiperbold:cupom:pagador:v1:${segredo}`).update(digitos).digest("hex");
}

/** Normaliza o código digitado: sem espaços nas pontas; vazio vira `undefined`. */
export function normalizarCodigoDeCupom(codigo: string | null | undefined): string | undefined {
  const limpo = (codigo ?? "").trim();
  return limpo === "" ? undefined : limpo;
}

/** Dois códigos são o mesmo cupom quando só diferem em maiúsculas e minúsculas (como no banco, que usa citext). */
export function mesmoCodigoDeCupom(a: string | null | undefined, b: string | null | undefined): boolean {
  return (normalizarCodigoDeCupom(a) ?? "").toLowerCase() === (normalizarCodigoDeCupom(b) ?? "").toLowerCase();
}

// ─── Simulação (a tela mostra o valor antes de confirmar) ───────────────

/** O que `fn_billing_cupom_simular` devolve, do jeito do banco. */
export type SimulacaoBruta =
  | {
      ok: true;
      codigo: string;
      tipo: "percentual" | "valor";
      valor: number;
      preco_cheio_cents: number;
      desconto_cents: number;
      total_cents: number;
      parcelas: number;
      total_final_cents: number;
    }
  | { ok: false; erro: string };

/** A leitura que a simulação usa: `fn_billing_cupom_simular`, só leitura. Separada de `DbCompra` (não faz parte da sequência de compra). */
export interface DbSimulacaoDeCupom {
  simularCupom(args: {
    org: string;
    codigo: string;
    planCode: string;
    ciclo: CicloPedido;
    parcelas: number;
  }): Promise<RpcResultado<SimulacaoBruta>>;
}

export interface SimulacaoDeCupom {
  codigo: string;
  /** `percentual` (valor = 1 a 99) ou `valor` (valor = centavos). */
  tipoDoDesconto: "percentual" | "valor";
  valor: number;
  precoCheioCents: number;
  descontoCents: number;
  /** O preço do ciclo já com desconto, sem os juros do parcelamento. */
  totalCents: number;
  parcelas: number;
  /** O total que o cliente paga: igual a `totalCents` à vista; com os juros calculados sobre o preço descontado no parcelado. */
  totalFinalCents: number;
}

export type ResultadoSimularCupom =
  | ({ tipo: "ok" } & SimulacaoDeCupom)
  | { tipo: "erro"; mensagem: string };

export const MENSAGEM_SIMULACAO_FALHOU = "Não foi possível conferir o cupom agora. Tente novamente em instantes.";
const MENSAGEM_PARCELAMENTO =
  "O parcelamento só está disponível no cartão de crédito, no plano semestral (até 6x) e no anual (até 12x).";

export interface EntradaSimularCupom {
  organizationId: string;
  codigo: string;
  planCode: string;
  ciclo: CicloPedido;
  metodo: "CREDIT_CARD" | "PIX";
  parcelas?: number;
}

/**
 * Simula o cupom no banco (só leitura). O banco decide tudo; aqui só se recusa o que o banco não sabe: o
 * parcelamento fora do cartão (a função do banco não recebe o método).
 */
export async function simularCupom(
  db: DbSimulacaoDeCupom,
  entrada: EntradaSimularCupom,
): Promise<ResultadoSimularCupom> {
  const parcelas = entrada.parcelas ?? 1;
  if (parcelas > 1 && entrada.metodo !== "CREDIT_CARD") {
    return { tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO };
  }

  const resposta = await db.simularCupom({
    org: entrada.organizationId,
    codigo: entrada.codigo,
    planCode: entrada.planCode,
    ciclo: entrada.ciclo,
    parcelas,
  });
  if (resposta.error || !resposta.data) return { tipo: "erro", mensagem: MENSAGEM_SIMULACAO_FALHOU };

  const d = resposta.data;
  if (!d.ok) {
    if (d.erro.includes("billing_parcelamento_") || d.erro.includes("billing_parcelas_")) {
      return { tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO };
    }
    if (d.erro.includes("plano_nao_encontrado_ou_inativo")) return { tipo: "erro", mensagem: "Oferta não encontrada." };
    if (d.erro.includes("billing_plano_fora_de_venda")) {
      return { tipo: "erro", mensagem: "Este plano não está disponível para compra no momento." };
    }
    if (d.erro.includes("billing_preco_nao_definido")) {
      return { tipo: "erro", mensagem: "O preço desta oferta ainda não foi definido." };
    }
    return { tipo: "erro", mensagem: mensagemDoErroDeCupom(d.erro) ?? MENSAGEM_SIMULACAO_FALHOU };
  }

  return {
    tipo: "ok",
    codigo: d.codigo,
    tipoDoDesconto: d.tipo,
    valor: d.valor,
    precoCheioCents: d.preco_cheio_cents,
    descontoCents: d.desconto_cents,
    totalCents: d.total_cents,
    parcelas: d.parcelas,
    totalFinalCents: d.total_final_cents,
  };
}
