/**
 * As etapas de reassumir uma conta cadastrada por e-mail cujo endereço o CRM nunca verificou, quando quem chegou
 * PROVOU o endereço por outro meio (D-204). Quem decide SE a conta deve ser reassumida é o chamador, pela prova
 * que tem: a volta do Google (`retomar-conta-pelo-google.ts`) ou o link de recuperação de senha
 * (`retomar-conta-pela-recuperacao.ts`). Aqui só a ORDEM, que é a segurança:
 *
 *   1. troca a senha por uma aleatória que ninguém conhece (quem criou a conta perde a chave);
 *   2. remove os fatores de MFA (o TOTP do criador trancaria a pessoa real num desafio que ela não passa). Se um
 *      fator VERIFICADO sai, o GoTrue encerra todas as sessões, a nova inclusive: `sessaoEncerrada`;
 *   3. derruba as OUTRAS sessões (`signOut(jwt, 'others')`) quando a nova ainda existe;
 *   4. só então carimba o e-mail como verificado.
 *
 * Carimbar antes e falhar no meio deixaria a conta "verificada" com a senha ou a sessão do atacante vivas, e a
 * faixa que avisaria a vítima já teria sumido. Qualquer etapa que falhe devolve `{ ok: false }` e QUEM CHAMA
 * fecha a entrada (falha fechada); as etapas são idempotentes, então tentar de novo é seguro.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { removerTodosOsFatores } from "./fatores-mfa-admin";
import { carimbarEmailVerificado } from "./verificacao-email";

type AdminMinimo = Pick<SupabaseClient, "auth">;

/**
 * Senha aleatória forte. 24 bytes de entropia; o sufixo fixo existe só para satisfazer política de senha do
 * GoTrue que exija classes de caracteres (maiúscula, minúscula, dígito, símbolo) e não reduz a entropia.
 */
export function senhaAleatoriaForte(): string {
  return `${randomBytes(24).toString("base64url")}-Aa1#`;
}

export type RetomadaDaConta =
  | {
      ok: true;
      retomada: boolean;
      /** Quantos fatores de MFA saíram (0 quando não houve retomada). */
      fatoresRemovidos: number;
      /** Um fator verificado saiu: o provedor encerrou todas as sessões, a nova inclusive. */
      sessaoEncerrada: boolean;
    }
  | { ok: false; etapa: "sem_sessao" | "senha" | "fatores" | "sessoes" | "carimbo" };

export async function reassumirConta(p: {
  admin: AdminMinimo;
  userId: string;
  /** O `access_token` da sessão que a prova acabou de abrir: é a sessão que SOBREVIVE ao `others`. */
  accessToken: string | null | undefined;
  agora?: Date;
  gerarSenha?: () => string;
}): Promise<RetomadaDaConta> {
  // Sem o token da sessão nova não há como dizer ao provedor qual preservar: derrubar "todas" derrubaria
  // também a da vítima. Falha fechada.
  if (!p.accessToken) return { ok: false, etapa: "sem_sessao" };

  const senha = (p.gerarSenha ?? senhaAleatoriaForte)();
  const trocada = await p.admin.auth.admin.updateUserById(p.userId, { password: senha });
  if (trocada.error) return { ok: false, etapa: "senha" };

  const fatores = await removerTodosOsFatores(p.admin, p.userId);
  if (!fatores.ok) return { ok: false, etapa: "fatores" };
  const sessaoEncerrada = fatores.verificadosRemovidos > 0;

  // Fator verificado removido: o provedor já encerrou todas as sessões (a nova também), não há "outras" a derrubar.
  if (!sessaoEncerrada) {
    const derrubadas = await p.admin.auth.admin.signOut(p.accessToken, "others");
    if (derrubadas.error) return { ok: false, etapa: "sessoes" };
  }

  const carimbo = await carimbarEmailVerificado({ admin: p.admin, userId: p.userId, agora: p.agora });
  if (!carimbo.ok) return { ok: false, etapa: "carimbo" };

  return { ok: true, retomada: true, fatoresRemovidos: fatores.removidos, sessaoEncerrada };
}
