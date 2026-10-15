/**
 * O `?plano=` do link "Assinar o X" do site de vendas (`/signup?plano=pro`). É só uma DICA para a tela de
 * pagamento pré-selecionar o plano: nunca define preço nem concede nada, e quem valida o plano contra os
 * que estão à venda é a própria tela de pagamento. Aqui só se garante a FORMA (minúsculas, dígitos e hífen,
 * 1 a 40 caracteres), porque o valor vira texto de formulário e `user_metadata.plano_escolhido`.
 */
const FORMA = /^[a-z0-9-]{1,40}$/;

export function sanitizarPlano(bruto: unknown): string | null {
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().toLowerCase();
  return FORMA.test(limpo) ? limpo : null;
}

/**
 * O site de vendas chama o terceiro plano de `scale`; o código dele em `billing_plans` é `escale`.
 * O apelido evita que um link antigo do site caia num plano inexistente (e, ignorado em silêncio, no
 * nenhum).
 */
const APELIDOS_DO_SITE: Record<string, string> = { scale: "escale" };

/**
 * Qual plano a tela de pagamento pré-seleciona: o `?plano=` da URL, e na falta (ou se não estiver à
 * venda) o que o cadastro guardou em `user_metadata.plano_escolhido`. Plano inválido ou fora de venda
 * é ignorado em silêncio — devolve `null` e a tela não marca nenhum. É só dica de seleção: o preço e
 * a compra são decididos no servidor a partir do catálogo.
 */
export function planoPreSelecionado(
  planosAVenda: readonly string[],
  candidatos: readonly unknown[],
): string | null {
  for (const bruto of candidatos) {
    const limpo = sanitizarPlano(bruto);
    if (!limpo) continue;
    const codigo = APELIDOS_DO_SITE[limpo] ?? limpo;
    if (planosAVenda.includes(codigo)) return codigo;
  }
  return null;
}
