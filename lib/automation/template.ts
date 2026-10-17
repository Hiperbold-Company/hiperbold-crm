import { resolveField } from "@/lib/automation/conditions";

const ALIASES: Record<string, string> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
};

/**
 * A marcação tem dono no CRM (contato ou negócio) — e por isso NÃO se preenche
 * de fora.
 *
 * Existe para quem recebe valor de terceiro (as variáveis do integrador em
 * `lib/operacao/modelos-de-mensagem.ts`): `{{nome}}` é alias de `contact.name`,
 * então um valor mandado para "nome" seria descartado em silêncio pelo render
 * — e quem mandou receberia o texto com a marcação vazia achando que preencheu.
 * A régua é por NOME, e não pelo dado: sem contato informado a marcação também
 * estaria vazia, e aí a recusa sumiria justamente no caso mais enganoso.
 */
export function marcacaoDoCrm(nome: string): boolean {
  return (
    ALIASES[nome] !== undefined || nome.startsWith("contact.") || nome.startsWith("lead.")
  );
}

/** `{{contact.cpf_hash}}` e `{{contact.cpf_encrypted}}` nunca saem num texto, mesmo que o contexto traga a coluna (D-216). */
const CAMPO_DO_CPF = /^contact\.cpf_/;

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    if (CAMPO_DO_CPF.test(ALIASES[path] ?? path)) return "";
    const resolved = resolveField(context, ALIASES[path] ?? path);
    // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
    const texto = String(resolved ?? "");
    return path === "primeiro_nome" ? (texto.trim().split(/\s+/)[0] ?? "") : texto;
  });
}
