/**
 * Enquanto a verificação de e-mail do CRM da conta está EM ABERTO, a conta não cria o que sobrevive à troca de
 * senha (D-204): chave de API (`dsk_`), conexão com MCP externo, entrada automática (webhook) e convite.
 *
 * Com a confirmação automática do provedor ligada, quem cadastra o e-mail alheio entra na conta sem provar o
 * endereço. Se pudesse criar uma chave, um convite ou uma entrada, esses artefatos seguiriam funcionando depois de
 * a vítima retomar a conta pelo Google ou pela recuperação de senha. A retomada também os revoga
 * (`lib/auth/reassumir-conta.ts`); esta trava fecha a janela antes.
 *
 * A regra é a de sempre (`emailVerificado`): conta antiga, do Google ou de instalação sem a verificação do CRM não
 * tem pedido em aberto e passa. Lê a conta no provedor (`app_metadata` só o servidor escreve) e FALHA FECHADA: se
 * não conseguir ler, recusa.
 */
import { fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

import { emailVerificado } from "./verificacao-email";

type AdminLeitor = Pick<ReturnType<typeof createAdminClient>, "auth">;

/** `true` quando a conta pode criar o que exige o e-mail provado. Nunca lança. */
export async function contaPodeCriarArtefatos(
  userId: string,
  admin: AdminLeitor = createAdminClient(),
): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) return false;
    return emailVerificado(data.user.app_metadata);
  } catch {
    return false;
  }
}

/**
 * A resposta 403 de rota, ou `null` quando pode seguir. `frase` já vem traduzida e completa
 * (`Confirme seu e-mail para criar chaves de API.`).
 */
export async function recusaSeEmailNaoVerificado(p: {
  userId: string | null;
  frase: string;
  requestId: string;
  admin?: AdminLeitor;
}): Promise<Response | null> {
  // Token sem dono ativo (`userId` nulo): quem decide é o próprio token, que uma conta com o e-mail em aberto não
  // consegue criar (esta trava) e que a retomada revoga. Não há conta para conferir.
  if (p.userId === null) return null;
  if (await contaPodeCriarArtefatos(p.userId, p.admin)) return null;
  return fail("email_not_verified", p.frase, 403, { requestId: p.requestId });
}
