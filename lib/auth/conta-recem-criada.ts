/**
 * A conta que o `signUp()` do provedor devolveu foi CRIADA agora por esta chamada?
 *
 * Só então a ação grava algo nela (aceite dos Termos, pedido de verificação). Dois casos devolvem um usuário
 * que NÃO é novo: o endereço já cadastrado e confirmado (o GoTrue devolve um usuário ofuscado, sem
 * `identities`, para a resposta ser igual à de um cadastro novo) e a conta antiga ainda não confirmada (id
 * real, `created_at` antigo). Escrever no `app_metadata` de uma conta alheia por conhecer o endereço seria
 * uma porta, então a conta só conta como nova com identidade e criação dos últimos minutos.
 */
const JANELA_DE_CONTA_NOVA_MS = 2 * 60 * 1000;
export function contaRecemCriada(
  u: { id?: string; created_at?: string; identities?: unknown[] | null } | null | undefined,
  agora: number = Date.now(),
): u is { id: string } {
  if (!u?.id) return false;
  if (Array.isArray(u.identities) && u.identities.length === 0) return false;
  const criada = Date.parse(u.created_at ?? "");
  return Number.isFinite(criada) && Math.abs(agora - criada) < JANELA_DE_CONTA_NOVA_MS;
}
