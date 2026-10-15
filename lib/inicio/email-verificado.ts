/**
 * O e-mail do usuário já foi confirmado pelo CRM? Lê o `app_metadata` do usuário de
 * autenticação e aplica a regra de `lib/auth/verificacao-email.ts`, no servidor (`app_metadata` só é gravável por service role: o usuário não se
 * autoverifica). É o ponto único da pergunta para a tela Início: quando a verificação própria do CRM
 * expuser outra forma de saber, troca-se o corpo desta função e mais nada.
 *
 * Fail-open: erro de leitura devolve `true`. Esta resposta só decide um item de lista e a abertura do
 * Início; travar o cliente numa tela por falha transitória seria pior do que mostrar o passo como feito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { emailVerificado as regraDoEmailVerificado } from "@/lib/auth/verificacao-email";
import { logger } from "@/lib/logger";

export async function emailVerificado(admin: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      throw new Error(error?.message ?? "usuário não encontrado");
    }
    // A regra é a da verificação própria do CRM (lib/auth/verificacao-email.ts): marcado OU sem
    // pedido em aberto. Contas de antes da verificação, do Google e de convite não têm pedido.
    return regraDoEmailVerificado(data.user.app_metadata);
  } catch (err) {
    logger.error("inicio_email_verificado_falhou", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return true;
  }
}
