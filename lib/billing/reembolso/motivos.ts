/**
 * O motivo do cancelamento (pesquisa de cancelamento, migration 0957): vocabulário fechado, o mesmo no formulário
 * de cancelar, no pedido de reembolso (que reaproveita o motivo do cancelamento), nos e-mails e na tela do admin.
 * O código é o que o banco aceita em `billing_cancel_feedback.motivo` e `billing_refund_requests.motivo`; o
 * rótulo é o texto em português (a chave de `t()` no formulário).
 *
 * Sem `server-only`: o formulário (componente cliente) importa daqui.
 */
export const MOTIVOS_DE_CANCELAMENTO = [
  "nao_usei_como_esperava",
  "preco",
  "faltou_recurso",
  "contratei_por_engano",
  "outro",
] as const;

export type MotivoDeCancelamento = (typeof MOTIVOS_DE_CANCELAMENTO)[number];

export const ROTULO_DO_MOTIVO: Record<MotivoDeCancelamento, string> = {
  nao_usei_como_esperava: "Não usei como esperava",
  preco: "Preço",
  faltou_recurso: "Faltou um recurso",
  contratei_por_engano: "Contratei por engano",
  outro: "Outro",
};

/** Teto do texto livre (o mesmo CHECK do banco). */
export const TAMANHO_MAXIMO_DO_DETALHE = 1000;

export function motivoValido(valor: unknown): valor is MotivoDeCancelamento {
  return typeof valor === "string" && (MOTIVOS_DE_CANCELAMENTO as readonly string[]).includes(valor);
}

/** O rótulo em português de um código vindo do banco; código desconhecido volta como veio. */
export function rotuloDoMotivo(codigo: string): string {
  return motivoValido(codigo) ? ROTULO_DO_MOTIVO[codigo] : codigo;
}
