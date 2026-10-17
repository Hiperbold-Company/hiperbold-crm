/**
 * Link de e-mail consumido agora (recuperação de senha, link mágico, OTP) sobre conta cadastrada por e-mail sem
 * verificação do CRM (D-204).
 *
 * O link chegou à caixa de entrada do endereço da conta: é prova de posse. Se a conta ainda tem a
 * verificação do CRM em aberto, quem a criou pode ter escolhido a senha, aberto sessões e cadastrado um TOTP sem
 * ser dono do endereço, e a pessoa real não conseguiria nem trocar a senha (o GoTrue exige AAL2 quando há fator
 * verificado). Então vale o mesmo que na volta do Google: senha aleatória, fatores de MFA fora, outras sessões
 * derrubadas e o e-mail carimbado (`reassumir-conta.ts`). A pessoa define a senha dela em seguida em
 * `/login/reset` (`app/actions/auth/updatePassword.ts`, que encerra todas as sessões ao terminar).
 *
 * Só roda quando o link de recuperação FOI consumido agora (`app/auth/confirm`): chamar de uma sessão qualquer
 * deixaria o atacante logado carimbar a própria conta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { SEM_REVOGADOS, reassumirConta, type RetomadaDaConta, type UsuarioParaReassumir } from "./reassumir-conta";
import { emailVerificado } from "./verificacao-email";

export async function retomarContaPelaRecuperacao(p: {
  admin: Pick<SupabaseClient, "auth" | "from">;
  usuario: UsuarioParaReassumir & { app_metadata?: unknown };
  accessToken: string | null | undefined;
  /** Troca a senha pela sessão nova (`supabase.auth.updateUser({ password })`). */
  trocarSenhaDaSessao: (senha: string) => Promise<{ error: unknown }>;
  agora?: Date;
  gerarSenha?: () => string;
}): Promise<RetomadaDaConta> {
  if (emailVerificado(p.usuario.app_metadata)) {
    return { ok: true, retomada: false, fatoresRemovidos: 0, sessaoEncerrada: false, revogados: SEM_REVOGADOS };
  }
  return await reassumirConta({
    admin: p.admin,
    usuario: p.usuario,
    accessToken: p.accessToken,
    trocarSenhaDaSessao: p.trocarSenhaDaSessao,
    agora: p.agora,
    gerarSenha: p.gerarSenha,
  });
}
