/**
 * As etapas de reassumir uma conta cadastrada por e-mail cujo endereço o CRM nunca verificou, quando quem chegou
 * PROVOU o endereço por outro meio (D-204). Quem decide SE a conta deve ser reassumida é o chamador, pela prova
 * que tem: a volta do Google (`retomar-conta-pelo-google.ts`) ou um link consumido agora na caixa de entrada do
 * endereço (recuperação de senha, link mágico, OTP; `retomar-conta-pela-recuperacao.ts`). Aqui só a ORDEM, que é
 * a segurança:
 *
 *   0. confere que a conta só tem as identidades que se sabe desfazer (e-mail e Google) e nenhum telefone. O
 *      GoTrue não oferece, pela admin API, desvincular identidade nem apagar telefone; uma identidade ou um
 *      telefone que sobrasse seria uma porta de volta para quem criou a conta. Se houver, RECUSA antes de mexer;
 *   1. derruba as OUTRAS sessões (`signOut(jwt, 'others')`), SEMPRE e primeiro: não depende do efeito colateral de
 *      nenhuma outra etapa;
 *   2. remove os fatores de MFA (o TOTP do criador trancaria a pessoa real num desafio que ela não passa, e o GoTrue
 *      exige AAL2 para trocar a senha enquanto houver fator verificado). Medido no GoTrue v2.196.0: o `deleteFactor`
 *      da admin API REBAIXA as sessões para AAL1, não as encerra (o auth-js diz o contrário); por isso a sessão nova
 *      é conferida depois (`sessaoEncerrada`), em vez de presumida;
 *   3. troca a senha por uma aleatória que ninguém conhece (quem criou a conta perde a chave). Pelo cliente da
 *      SESSÃO NOVA (`PUT /user`), não pela admin API: medido no GoTrue v2.196.0, a admin API apaga TODAS as
 *      sessões da conta ao trocar a senha, a nova inclusive, e o `signOut(others)` seguinte falharia; a troca pela
 *      sessão preserva a corrente e derruba as outras de novo (fecha a janela em que o criador entrou outra vez
 *      com a senha antiga). Sem sessão viva (a etapa 2 a encerrou), cai na admin API;
 *   4. revoga o que a conta criou enquanto o endereço não era provado e que sobreviveria à troca de senha: chaves
 *      de API (`dsk_`), convites pendentes e entradas automáticas (webhooks de captação), com a contagem;
 *   5. só então carimba o e-mail como verificado.
 *
 * Carimbar antes e falhar no meio deixaria a conta "verificada" com a senha ou a sessão do atacante vivas, e a
 * faixa que avisaria a vítima já teria sumido. Qualquer etapa que falhe devolve `{ ok: false }` e QUEM CHAMA
 * fecha a entrada (falha fechada); as etapas são idempotentes, então tentar de novo é seguro.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { removerTodosOsFatores } from "./fatores-mfa-admin";
import { carimbarEmailVerificado } from "./verificacao-email";

type AdminMinimo = Pick<SupabaseClient, "auth" | "from">;

/**
 * Senha aleatória forte. 24 bytes de entropia; o sufixo fixo existe só para satisfazer política de senha do
 * GoTrue que exija classes de caracteres (maiúscula, minúscula, dígito, símbolo) e não reduz a entropia.
 */
export function senhaAleatoriaForte(): string {
  return `${randomBytes(24).toString("base64url")}-Aa1#`;
}

/** O recorte do usuário que a conferência de identidades lê. */
export interface UsuarioParaReassumir {
  id: string;
  phone?: string | null;
  identities?: ReadonlyArray<{ provider?: string }> | null;
}

/** Provedores de identidade que a reassunção sabe deixar como estão: e-mail e Google. */
const IDENTIDADES_CONHECIDAS = new Set(["email", "google"]);

/**
 * A conta tem alguma identidade que não é de e-mail nem do Google, ou um telefone? Não há como desfazer isso pela
 * admin API (auth-js 2.117.2: sem `deleteIdentity`; `phone: ""` na atualização é "não mudar"), então vira recusa.
 */
export function temPortaQueNaoSeFecha(usuario: UsuarioParaReassumir): boolean {
  if ((usuario.phone ?? "").trim() !== "") return true;
  return (usuario.identities ?? []).some((i) => !IDENTIDADES_CONHECIDAS.has(i.provider ?? ""));
}

export interface Revogados {
  tokens: number;
  convites: number;
  entradas: number;
}

export type RetomadaDaConta =
  | {
      ok: true;
      retomada: boolean;
      /** Quantos fatores de MFA saíram (0 quando não houve retomada). */
      fatoresRemovidos: number;
      /** Um fator verificado saiu: o provedor encerrou todas as sessões, a nova inclusive. */
      sessaoEncerrada: boolean;
      /** O que a conta tinha criado e foi revogado. */
      revogados: Revogados;
    }
  | {
      ok: false;
      etapa: "sem_sessao" | "identidades" | "senha" | "sessoes" | "fatores" | "revogacao" | "carimbo";
    };

export const SEM_REVOGADOS: Revogados = { tokens: 0, convites: 0, entradas: 0 };

/** Revoga o que a conta criou e sobrevive à troca de senha. Devolve a contagem, ou `null` se alguma consulta falhou. */
export async function revogarCriadosPelaConta(
  admin: Pick<SupabaseClient, "from">,
  userId: string,
  agora: Date,
): Promise<Revogados | null> {
  const iso = agora.toISOString();

  const tokens = await admin
    .from("api_tokens")
    .update({ revoked_at: iso, revoked_by: userId, updated_at: iso })
    .eq("created_by", userId)
    .is("revoked_at", null)
    .select("id");
  if (tokens.error) return null;

  const convites = await admin
    .from("team_invites")
    .update({ revoked_at: iso, revoked_by: userId, updated_at: iso })
    .eq("invited_by", userId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (convites.error) return null;

  const entradas = await admin
    .from("webhook_sources")
    .update({ is_active: false, updated_at: iso })
    .eq("created_by_user_id", userId)
    .eq("is_active", true)
    .select("id");
  if (entradas.error) return null;

  return {
    tokens: tokens.data?.length ?? 0,
    convites: convites.data?.length ?? 0,
    entradas: entradas.data?.length ?? 0,
  };
}

export async function reassumirConta(p: {
  admin: AdminMinimo;
  usuario: UsuarioParaReassumir;
  /** O `access_token` da sessão que a prova acabou de abrir: é a sessão que SOBREVIVE ao `others`. */
  accessToken: string | null | undefined;
  /** Troca a senha PELA SESSÃO nova (`supabase.auth.updateUser({ password })` do cliente de cookie). */
  trocarSenhaDaSessao: (senha: string) => Promise<{ error: unknown }>;
  agora?: Date;
  gerarSenha?: () => string;
}): Promise<RetomadaDaConta> {
  const agora = p.agora ?? new Date();
  const userId = p.usuario.id;

  // Sem o token da sessão nova não há como dizer ao provedor qual preservar: derrubar "todas" derrubaria
  // também a da vítima. Falha fechada.
  if (!p.accessToken) return { ok: false, etapa: "sem_sessao" };
  if (temPortaQueNaoSeFecha(p.usuario)) return { ok: false, etapa: "identidades" };

  // SEMPRE e primeiro: a sessão do criador cai por esta chamada, não por efeito colateral de outra etapa.
  const derrubadas = await p.admin.auth.admin.signOut(p.accessToken, "others");
  if (derrubadas.error) return { ok: false, etapa: "sessoes" };

  const fatores = await removerTodosOsFatores(p.admin, userId);
  if (!fatores.ok) return { ok: false, etapa: "fatores" };
  // A sessão nova ainda vale? (Depende da versão do provedor; confere em vez de presumir.)
  const sessaoEncerrada = fatores.removidos > 0 ? Boolean((await p.admin.auth.getUser(p.accessToken)).error) : false;

  const senha = (p.gerarSenha ?? senhaAleatoriaForte)();
  const trocada = sessaoEncerrada
    ? await p.admin.auth.admin.updateUserById(userId, { password: senha })
    : await p.trocarSenhaDaSessao(senha);
  if (trocada.error) return { ok: false, etapa: "senha" };

  const revogados = await revogarCriadosPelaConta(p.admin, userId, agora);
  if (!revogados) return { ok: false, etapa: "revogacao" };

  const carimbo = await carimbarEmailVerificado({ admin: p.admin, userId, agora: p.agora });
  if (!carimbo.ok) return { ok: false, etapa: "carimbo" };

  return { ok: true, retomada: true, fatoresRemovidos: fatores.removidos, sessaoEncerrada, revogados };
}
