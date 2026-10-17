/**
 * Teto de papel de uma chave de API na EMISSÃO (0962, auditoria de 17/10/2026).
 *
 * Uma chave nunca declara um `role:` acima do papel ATUAL de quem a cria na
 * organização. O autenticador (`lib/mcp/auth.ts`) já recusa a chave cujo criador
 * não alcança o papel, a cada chamada; este teto faz a chave nem nascer assim.
 *
 * Sem nenhum `role:` a chave vale como `agent` (mesmo default de `scopesRole`),
 * então o piso também é conferido: quem não alcança `agent` não emite chave.
 */
import { ROLE_RANK, type Role } from "@/lib/auth/types";

/**
 * O primeiro papel pedido nos escopos que passa do papel de quem cria, ou `null`
 * quando tudo cabe. Papel desconhecido conta como acima do teto (falha fechada).
 */
export function papelAcimaDoCriador(scopes: readonly string[], papelDoCriador: Role): Role | null {
  const pedidos = scopes
    .filter((s) => s.startsWith("role:"))
    .map((s) => s.slice("role:".length) as Role);
  const efetivos: Role[] = pedidos.length > 0 ? pedidos : ["agent"];
  const teto = ROLE_RANK[papelDoCriador] ?? 0;
  for (const papel of efetivos) {
    if ((ROLE_RANK[papel] ?? Number.POSITIVE_INFINITY) > teto) return papel;
  }
  return null;
}
