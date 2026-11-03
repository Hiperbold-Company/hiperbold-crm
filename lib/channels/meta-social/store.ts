/**
 * As contas conectadas do canal social oficial — conectar, listar, arquivar,
 * credencial para enviar.
 *
 * Toda função recebe a organização de FONTE CONFIÁVEL (cookie na listagem e no
 * arquivamento; `state` assinado no callback) e filtra por ela: o cliente é
 * service role, que ignora a RLS.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import { recusaDoPlano } from "@/lib/billing/planos/recusa-do-plano";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { canalDaConversa, type PlataformaMetaSocial } from "./constantes";
import type { MotivoDaVolta } from "./motivos";
import { assinarWebhookDaConta, desassinarWebhookDaConta, type ContaDaMeta } from "./oauth";

export type MotivoDaRecusa = Extract<
  MotivoDaVolta,
  "conta_em_outra_organizacao" | "limite_do_plano" | "cifra_indisponivel" | "gravacao_falhou"
>;

export class ConexaoRecusada extends Error {
  constructor(readonly motivo: MotivoDaRecusa) {
    super(motivo);
    this.name = "ConexaoRecusada";
  }
}

/**
 * Chave do `metadata` da sessão com o id da pessoa da Meta que autorizou. Em
 * metadata e não em coluna: só a exclusão de dados lê, raramente, e sem
 * precisar de índice.
 */
export const CHAVE_DO_AUTORIZADOR = "meta_autorizador_id";
/** Chave do `metadata` com o portfólio de negócios do cliente (Instagram pelo login unificado). */
export const CHAVE_DA_EMPRESA = "meta_client_business_id";

/** Status que a tela lê como saudável. Qualquer outro pede "Reconectar". */
export const STATUS_SAUDAVEL = "WORKING";

interface LinhaDaConta {
  id: string;
  organization_id: string;
  archived_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Ator {
  userId: string;
  authSessionId?: string;
  requestId?: string;
}

const SELECT_CONTA = "id, organization_id, archived_at, metadata";

/** A org já tem (ativa) alguma conta desta rede? Usado para a reconexão no /conectar. */
export async function temContaDaPlataforma(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaMetaSocial,
): Promise<boolean> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", plataforma)
    .is("archived_at", null)
    .limit(1);
  return (data ?? []).length > 0;
}

/**
 * Conecta (ou reconecta) UMA conta. Ordem:
 *   1. Conta viva em OUTRA organização → recusa (o webhook ficaria ambíguo).
 *   2. Viva nesta → só troca o token (reconectar não duplica nem conta no plano).
 *   3. Arquivada nesta → reativa a linha (o histórico continua na mesma sessão).
 *   4. Nova → `podeCriar` e INSERT; o gatilho de plano (PT402) é a guarda real.
 *   5. Assina o webhook da conta; falha deixa a sessão FAILED e diz `recebimento: false`.
 */
export async function conectarConta(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    plataforma: PlataformaMetaSocial;
    conta: ContaDaMeta;
    token: string;
    expiraEm: string | null;
    ator: Ator;
    /**
     * Id app-scoped de quem autorizou (Instagram: o `/me` do token, que no
     * login unificado é o USUÁRIO DO SISTEMA de integração; Messenger: `/me`
     * do usuário do Facebook). A exclusão de dados casa por ele e pela conta.
     * Ausente = mantém o que havia.
     */
    autorizadorId?: string | null;
    /** `client_business_id` do portfólio (só Instagram). Ausente = mantém. */
    empresaId?: string | null;
  },
  assinar: typeof assinarWebhookDaConta = assinarWebhookDaConta,
): Promise<{ channelId: string; reconectado: boolean; recebimento: boolean }> {
  const { organizationId, plataforma, conta } = input;
  // cerca-canal: conta_viva_em_outra_organizacao (tests/unit/canal-consulta-por-organizacao.test.ts)
  const { data: vivas, error: erroVivas } = await admin
    .from("channel_sessions")
    .select(SELECT_CONTA)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", plataforma)
    .eq("meta_social_account_id", conta.id)
    .is("archived_at", null);
  if (erroVivas) throw new ConexaoRecusada("gravacao_falhou");
  const linhasVivas = (vivas ?? []) as LinhaDaConta[];
  if (linhasVivas.some((l) => l.organization_id !== organizationId)) {
    throw new ConexaoRecusada("conta_em_outra_organizacao");
  }
  let alvo: LinhaDaConta | null = linhasVivas[0] ?? null;
  if (!alvo) {
    // cerca-canal: linha_arquivada_da_propria_organizacao (tests/unit/canal-consulta-por-organizacao.test.ts)
    const { data: arquivadas } = await admin
      .from("channel_sessions")
      .select(SELECT_CONTA)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
      .eq("meta_social_platform", plataforma)
      .eq("meta_social_account_id", conta.id)
      .not("archived_at", "is", null)
      .order("archived_at", { ascending: false })
      .limit(1);
    alvo = ((arquivadas ?? []) as LinhaDaConta[])[0] ?? null;
  }

  const tokenCifrado = await encryptWebhookSecret(admin, input.token);
  if (!tokenCifrado) throw new ConexaoRecusada("cifra_indisponivel");

  const agora = new Date().toISOString();
  const rotulo = plataforma === "instagram" ? "Instagram" : "Messenger";
  const apelido = conta.usuario ? `@${conta.usuario}` : (conta.nome ?? conta.id);
  const patch = {
    meta_social_token_encrypted: tokenCifrado,
    meta_social_token_expires_at: input.expiraEm,
    meta_social_token_refreshed_at: agora,
    meta_social_username: conta.usuario,
    display_name: `${rotulo} · ${apelido}`,
    status: "STARTING",
    status_reason: null,
    last_status_change_at: agora,
    metadata: {
      ...(alvo?.metadata ?? metadataInicialDoCanal()),
      social_platform: canalDaConversa(plataforma),
      nome_da_conta: conta.nome,
      conectado_em: agora,
      token_erro: null,
      ...(input.autorizadorId ? { [CHAVE_DO_AUTORIZADOR]: input.autorizadorId } : {}),
      ...(input.empresaId ? { [CHAVE_DA_EMPRESA]: input.empresaId } : {}),
    },
  };

  const reconectado = Boolean(alvo);
  let channelId: string;
  if (alvo && !alvo.archived_at) {
    const { error } = await admin
      .from("channel_sessions")
      .update(patch)
      .eq("organization_id", organizationId)
      .eq("id", alvo.id);
    if (error) throw new ConexaoRecusada("gravacao_falhou");
    channelId = alvo.id;
  } else {
    const plano = await podeCriar(admin, organizationId, "conexoes");
    if (!plano.pode) throw new ConexaoRecusada("limite_do_plano");
    if (alvo) {
      const r = await reactivateChannelSession(
        admin,
        { organizationId, channelSessionId: alvo.id, archivedAt: alvo.archived_at },
        patch,
        { userId: input.ator.userId, requestId: input.ator.requestId ?? null, metadata: { plataforma } },
      );
      if (r.error) {
        if (recusaDoPlano(r.error)) throw new ConexaoRecusada("limite_do_plano");
        if (r.error.code === "23505") throw new ConexaoRecusada("conta_em_outra_organizacao");
        throw new ConexaoRecusada("gravacao_falhou");
      }
      channelId = alvo.id;
    } else {
      const segredo = await encryptWebhookSecret(admin, randomBytes(32).toString("hex"));
      if (!segredo) throw new ConexaoRecusada("cifra_indisponivel");
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: organizationId,
          provider: CHANNEL_PROVIDER_META_SOCIAL,
          meta_social_platform: plataforma,
          meta_social_account_id: conta.id,
          // NOT NULL na tabela; este canal não usa token por caminho (o
          // webhook é um endereço da instalação), então é só um valor aleatório.
          webhook_path_token: randomBytes(24).toString("hex"),
          webhook_secret_encrypted: segredo,
          created_by: input.ator.userId,
          ...patch,
        })
        .select("id")
        .single();
      if (error || !data) {
        if (recusaDoPlano(error)) throw new ConexaoRecusada("limite_do_plano");
        if (error?.code === "23505") throw new ConexaoRecusada("conta_em_outra_organizacao");
        logger.error("[meta-social.store] insert falhou", { codigo: error?.code });
        throw new ConexaoRecusada("gravacao_falhou");
      }
      channelId = (data as { id: string }).id;
    }
  }

  let recebimento = true;
  try {
    await assinar(plataforma, conta.id, input.token);
  } catch (err) {
    recebimento = false;
    logger.warn("[meta-social.store] assinatura do webhook falhou", {
      organization_id: organizationId,
      plataforma,
      detalhe: err instanceof Error ? err.message : "erro",
    });
  }
  await admin
    .from("channel_sessions")
    .update(
      recebimento
        ? { status: STATUS_SAUDAVEL, status_reason: null }
        : { status: "FAILED", status_reason: "assinatura_do_webhook_falhou" },
    )
    .eq("organization_id", organizationId)
    .eq("id", channelId);

  await audit({
    action: reconectado ? "channel.reconnected" : "channel.connected",
    organizationId,
    actorUserId: input.ator.userId,
    actorAuthSessionId: input.ator.authSessionId,
    resourceType: "channel_session",
    resourceId: channelId,
    requestId: input.ator.requestId ?? null,
    metadata: { provider: CHANNEL_PROVIDER_META_SOCIAL, plataforma, conta_id: conta.id, recebimento },
  });
  return { channelId, reconectado, recebimento };
}

export interface ContaListada {
  id: string;
  plataforma: PlataformaMetaSocial;
  nome: string | null;
  usuario: string | null;
  conectado_em: string;
  token_expira_em: string | null;
  status: string;
}

/** `conectado` quando a sessão está de pé e o token não venceu; senão, o motivo. */
export function statusDaConta(linha: {
  status: string | null;
  meta_social_token_expires_at: string | null;
  metadata: Record<string, unknown> | null;
}, agora: Date = new Date()): string {
  if (linha.metadata?.token_erro) return "token_falhou";
  if (linha.meta_social_token_expires_at && Date.parse(linha.meta_social_token_expires_at) <= agora.getTime())
    return "token_vencido";
  return linha.status === STATUS_SAUDAVEL ? "conectado" : "precisa_reconectar";
}

export async function listarContas(admin: SupabaseClient, organizationId: string): Promise<ContaListada[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(
      "id, meta_social_platform, meta_social_username, display_name, created_at, meta_social_token_expires_at, status, metadata",
    )
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error("meta_social_list_failed");
  return ((data ?? []) as Record<string, unknown>[]).map((l) => {
    const metadata = (l.metadata ?? {}) as Record<string, unknown>;
    return {
      id: l.id as string,
      plataforma: l.meta_social_platform as PlataformaMetaSocial,
      nome: (metadata.nome_da_conta as string | null) ?? (l.display_name as string | null) ?? null,
      usuario: (l.meta_social_username as string | null) ?? null,
      conectado_em: (metadata.conectado_em as string | undefined) ?? (l.created_at as string),
      token_expira_em: (l.meta_social_token_expires_at as string | null) ?? null,
      status: statusDaConta({
        status: l.status as string | null,
        meta_social_token_expires_at: l.meta_social_token_expires_at as string | null,
        metadata,
      }),
    };
  });
}

/** A credencial de envio de uma conta viva da organização. */
export async function credencialDaConta(
  admin: SupabaseClient,
  organizationId: string,
  contaId: string,
): Promise<{ sessionId: string; plataforma: PlataformaMetaSocial; token: string } | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, meta_social_platform, meta_social_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_account_id", contaId)
    .is("archived_at", null)
    .limit(2);
  const linhas = (data ?? []) as {
    id: string;
    meta_social_platform: PlataformaMetaSocial;
    meta_social_token_encrypted: string | null;
  }[];
  if (linhas.length !== 1 || !linhas[0]!.meta_social_token_encrypted) return null;
  const token = await decryptWebhookSecret(admin, linhas[0]!.meta_social_token_encrypted);
  if (!token) return null;
  return { sessionId: linhas[0]!.id, plataforma: linhas[0]!.meta_social_platform, token };
}

/**
 * Arquiva a conta da própria organização. Tenta antes (best-effort) tirar a
 * assinatura do webhook na Meta; o token é apagado da linha.
 * `null` = não existe nesta organização.
 */
export async function arquivarConta(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  desassinar: typeof desassinarWebhookDaConta = desassinarWebhookDaConta,
): Promise<{ plataforma: PlataformaMetaSocial; contaId: string; desassinado: boolean } | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, meta_social_platform, meta_social_account_id, meta_social_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) return null;
  const linha = data as {
    meta_social_platform: PlataformaMetaSocial;
    meta_social_account_id: string;
    meta_social_token_encrypted: string | null;
  };
  let desassinado = false;
  if (linha.meta_social_token_encrypted) {
    const token = await decryptWebhookSecret(admin, linha.meta_social_token_encrypted);
    if (token) {
      try {
        await desassinar(linha.meta_social_platform, linha.meta_social_account_id, token);
        desassinado = true;
      } catch {
        desassinado = false;
      }
    }
  }
  const agora = new Date().toISOString();
  const { error } = await admin
    .from("channel_sessions")
    .update({
      archived_at: agora,
      status: "STOPPED",
      last_status_change_at: agora,
      meta_social_token_encrypted: null,
    })
    .eq("organization_id", organizationId)
    .eq("id", id);
  if (error) throw new Error("meta_social_archive_failed");
  return { plataforma: linha.meta_social_platform, contaId: linha.meta_social_account_id, desassinado };
}
