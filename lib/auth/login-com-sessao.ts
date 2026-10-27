import { safeNext } from "@/lib/auth/safe-next";

/**
 * Para onde `/login` manda quem JÁ está logado — ou `null` para mostrar o formulário.
 *
 * Sessão válida (o `getUser()` da página confirmou) não precisa de senha de
 * novo: segue para o `next`, mas só quando ele é caminho interno seguro
 * (`safeNext` — `//evil.example`, `https://...` e afins viram `/app`).
 *
 * Fica no formulário quando a tela veio dar um recado (`error`, `reset`,
 * `recovery_used`): o aviso precisa ser lido, e quem chega com ele em geral
 * acabou de perder a sessão de propósito. Pular a tela apagaria a explicação.
 */
export function destinoDoLoginComSessao(p: {
  logado: boolean;
  next?: string;
  reset?: string;
  error?: string;
  recovery_used?: string;
}): string | null {
  if (!p.logado) return null;
  if (p.error || p.reset || p.recovery_used) return null;
  return safeNext(p.next, "/app");
}
