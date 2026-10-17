/**
 * Pré-sequestro de conta pela entrada com Google (D-204).
 *
 * ─── O ataque ───────────────────────────────────────────────────────────────
 *
 * Com a confirmação automática do provedor ligada (`mailer_autoconfirm = true`), qualquer pessoa cadastra
 * `vitima@empresa.com` com uma senha que ela escolheu, sem provar que o endereço é dela. Quando a vítima
 * entra depois com o Google, o GoTrue LIGA a identidade do Google à conta que já existe (o e-mail é o mesmo e
 * o provedor o dá como confirmado). A vítima passa a usar a conta, e quem a criou segue entrando pela senha.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * A conta tem verificação do CRM EM ABERTO (`emailVerificado(app_metadata) === false`: foi criada pelo
 * cadastro com e-mail e o link nunca foi aberto) E quem chegou provou o endereço pelo Google
 * (`identity_data.email_verified` da identidade do Google, com o mesmo endereço da conta). Então:
 *
 *   1. derruba TODAS as outras sessões (`signOut(jwt, 'others')`: o criador pode já estar logado), sempre e primeiro;
 *   2. remove os fatores de MFA (o TOTP do criador seguraria a vítima num desafio que ela não passa);
 *   3. troca a senha por uma aleatória que ninguém conhece, pela sessão nova;
 *   4. revoga o que a conta criou (chaves de API, convites pendentes, entradas automáticas);
 *   5. só então carimba o e-mail como verificado.
 * A ordem e o porquê (medidos no GoTrue real) estão em `reassumir-conta.ts`.
 *
 * A ordem é a segurança: carimbar antes e falhar no meio deixaria a conta "verificada" com a senha do
 * atacante viva, e a faixa que avisaria a vítima já teria sumido. Qualquer etapa que falhe devolve
 * `{ ok: false }` e QUEM CHAMA fecha a entrada (falha fechada). A vítima volta a tentar; as etapas são
 * idempotentes.
 *
 * Conta que NÃO tem pedido em aberto (Google desde o início, convite, cadastro antigo) não é tocada: não há
 * senha de terceiro a desfazer, e trocar a senha de quem escolheu a própria seria um dano.
 *
 * Todo cadastro por e-mail e senha nasce com o pedido em aberto, qualquer que seja o caminho (a ação de cadastro do
 * CRM ou o `POST /auth/v1/signup` direto com a anon key): o gatilho de `auth.users` da migration 0966 o grava. As
 * etapas (senha, MFA, sessões, carimbo) estão em `reassumir-conta.ts`, compartilhadas com a recuperação de senha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { SEM_REVOGADOS, reassumirConta, type RetomadaDaConta } from "./reassumir-conta";
import { emailVerificado } from "./verificacao-email";

export { senhaAleatoriaForte } from "./reassumir-conta";
export type { RetomadaDaConta } from "./reassumir-conta";

type AdminMinimo = Pick<SupabaseClient, "auth" | "from">;

/** O recorte do usuário que a regra lê. Estrutural, para o teste não depender do tipo inteiro do SDK. */
export interface UsuarioDoRetorno {
  id: string;
  email?: string | null;
  phone?: string | null;
  app_metadata?: unknown;
  identities?: ReadonlyArray<{ provider?: string; identity_data?: unknown }> | null;
}

/**
 * O Google provou o endereço desta conta? Exige a identidade do Google na conta, `email_verified === true` e o
 * MESMO endereço da conta (sem diferenciar maiúsculas). Qualquer dúvida é "não provou".
 */
export function googleProvouOEmail(usuario: UsuarioDoRetorno): boolean {
  const emailDaConta = usuario.email?.trim().toLowerCase();
  if (!emailDaConta) return false;
  // EXISTE uma identidade do Google com o endereço verificado e igual ao da conta? (`some`, e não o primeiro
  // `find`: a conta pode ter mais de uma identidade do mesmo provedor, e a que prova é a que satisfaz tudo.)
  return (usuario.identities ?? []).some((i) => {
    if (i.provider !== "google" || !i.identity_data || typeof i.identity_data !== "object") return false;
    const dados = i.identity_data as { email?: unknown; email_verified?: unknown };
    return (
      dados.email_verified === true &&
      typeof dados.email === "string" &&
      dados.email.trim().toLowerCase() === emailDaConta
    );
  });
}

/** A regra pura: retoma quem tem verificação do CRM em aberto E o Google provou o endereço. */
export function contaPrecisaSerRetomada(usuario: UsuarioDoRetorno): boolean {
  return googleProvouOEmail(usuario) && !emailVerificado(usuario.app_metadata);
}

export async function retomarContaPeloGoogle(p: {
  admin: AdminMinimo;
  usuario: UsuarioDoRetorno;
  /** O `access_token` da sessão que o Google acabou de abrir: é a sessão que SOBREVIVE ao `others`. */
  accessToken: string | null | undefined;
  /** Troca a senha pela sessão nova (`supabase.auth.updateUser({ password })`). */
  trocarSenhaDaSessao: (senha: string) => Promise<{ error: unknown }>;
  agora?: Date;
  gerarSenha?: () => string;
}): Promise<RetomadaDaConta> {
  if (!contaPrecisaSerRetomada(p.usuario)) {
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
