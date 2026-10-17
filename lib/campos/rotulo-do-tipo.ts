import type { CustomFieldDef } from "@/lib/schemas/settings";

export type TipoDeCampoPersonalizado = CustomFieldDef["type"];

/**
 * Rótulo de tela de cada tipo de campo personalizado.
 *
 * Só o que se EXIBE: o valor gravado em `pipeline.settings.fields[].type` e o
 * contrato da API seguem `text`, `multiselect` etc. A tabela é um `Record`
 * sobre o tipo do schema: tipo novo lá reprova o typecheck aqui até ganhar
 * rótulo. Passe o resultado por `t()` ao renderizar.
 */
export const ROTULO_DO_TIPO_DE_CAMPO: Record<TipoDeCampoPersonalizado, string> = {
  text: "Texto",
  textarea: "Texto longo",
  number: "Número",
  date: "Data",
  select: "Lista de opções",
  multiselect: "Lista de várias opções",
  boolean: "Sim ou não",
  email: "E-mail",
  phone: "Telefone",
  url: "Link",
};

/** Rótulo de um tipo vindo do banco; valor desconhecido volta como veio. */
export function rotuloDoTipoDeCampo(tipo: string | null | undefined): string {
  if (!tipo) return "";
  return Object.hasOwn(ROTULO_DO_TIPO_DE_CAMPO, tipo)
    ? ROTULO_DO_TIPO_DE_CAMPO[tipo as TipoDeCampoPersonalizado]
    : tipo;
}
