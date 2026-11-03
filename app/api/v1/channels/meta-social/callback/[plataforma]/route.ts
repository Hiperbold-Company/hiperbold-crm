/**
 * GET /api/v1/channels/meta-social/callback/{instagram|messenger} — a volta do
 * consentimento da Meta.
 *
 * Caminho PÚBLICO no proxy (`lib/auth/public-paths.ts`): a navegação vem de
 * outro site e o cookie de sessão (`SameSite=Strict`) não viaja nela. A
 * identidade vem do `state` assinado (organização, usuário, sessão de login,
 * plataforma), somado ao cookie de vínculo `Lax` que prova que o navegador que
 * volta é o que saiu, ao nonce de uso único e a uma reconferência no banco de
 * que a pessoa AINDA administra a organização.
 *
 * A ordem é contrato (molde do callback da agenda):
 *   1. `error` da Meta → a pessoa cancelou; volta sem barulho.
 *   2. `state` antes do `code`: sem saber de quem é, não há org para auditar.
 *   3. vínculo do navegador.
 *   4. autoridade atual (papel no banco + cerca do suporte) antes de efeito.
 *   5. QUEIMA do nonce antes de trocar o código: replay morre aqui (23505).
 *   6. troca do código, conta(s), conexão.
 *
 * Todo desfecho volta para `/app/connections?aba=sociais&meta_social=ok|erro|parcial
 * &motivo=<código>&n=<quantas contas>&recusadas=<quantas não>`. Os códigos de
 * `motivo` são os de `lib/channels/meta-social/motivos.ts`, o mesmo conjunto
 * que a tela traduz.
 *
 * Auditoria antes de queimar o nonce NÃO leva a organização do `state`: até
 * ali o `state` pode ser uma cópia (vazou de um histórico, de um log), e quem a
 * tem não pode escrever trilha na organização de outra pessoa. Depois do nonce
 * queimado o `state` é deste navegador e deste uso, e a falha vai para a
 * organização dele.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import { PLATAFORMAS_META_SOCIAL, caminhoDoCallback, type PlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";
import { NOME_DO_VINCULO_META_SOCIAL, verificarEstadoMetaSocial, vinculoMetaSocialConfere } from "@/lib/channels/meta-social/estado";
import {
  ErroDaMeta,
  contasInstagramConcedidas,
  paginasMessenger,
  tokenLongoMessenger,
  trocarCodigoLoginUnificado,
  trocarCodigoMessenger,
  usuarioDoFacebook,
  usuarioDoSistema,
  type ContaDaMeta,
} from "@/lib/channels/meta-social/oauth";
import type { MotivoDaVolta } from "@/lib/channels/meta-social/motivos";
import { ConexaoRecusada, conectarConta, type Ator } from "@/lib/channels/meta-social/store";
import { redirectUriDe, voltarParaConexoes } from "@/lib/channels/meta-social/volta";
import { env } from "@/lib/env";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const parametros = z.object({ plataforma: z.enum(PLATAFORMAS_META_SOCIAL) });

interface RouteCtx {
  params: Promise<{ plataforma: string }>;
}

const erro = (motivo: MotivoDaVolta) => voltarParaConexoes({ meta_social: "erro", motivo, n: 0 });

/** A pessoa do `state` ainda é admin da organização (ou admin de plataforma ativo)? */
async function aindaAdministra(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const { data: vinculo } = await admin
    .from("user_organizations")
    .select("role, revoked_at")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  const v = vinculo as { role: string; revoked_at: string | null } | null;
  if (v && v.revoked_at === null && v.role === "admin") return true;
  const { data: plataforma } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  return Boolean(plataforma);
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const lido = parametros.safeParse(await ctx.params);
  if (!lido.success) return erro("plataforma_invalida");
  const plataforma: PlataformaMetaSocial = lido.data.plataforma;
  const url = req.nextUrl;

  if (url.searchParams.get("error")) return erro("conexao_cancelada");

  let estado: ReturnType<typeof verificarEstadoMetaSocial> = null;
  try {
    estado = verificarEstadoMetaSocial(url.searchParams.get("state"), {
      segredo: env.INTERNAL_SECRET,
      agora: new Date(),
      plataforma,
    });
  } catch {
    return erro("retorno_nao_verificavel");
  }
  if (!estado) return erro("retorno_nao_verificavel");
  const { organizationId, userId } = estado;
  /** Falha ANTES de o nonce ser queimado: trilha da instalação, sem a organização do state. */
  const recusouSemVinculo = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await audit({
      action: "channel.meta_social_connect_failed",
      resourceType: "channel_session",
      metadata: { plataforma, motivo, ...(detalhe ? { detalhe } : {}) },
    });
    return erro(motivo);
  };
  /** Falha DEPOIS do nonce queimado: o state é deste uso, a trilha vai para a organização dele. */
  const registrarFalha = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await audit({
      action: "channel.meta_social_connect_failed",
      organizationId,
      actorUserId: userId,
      actorAuthSessionId: estado?.authSessionId,
      resourceType: "channel_session",
      metadata: { plataforma, motivo, ...(detalhe ? { detalhe } : {}) },
    });
  };
  const falhou = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await registrarFalha(motivo, detalhe);
    return erro(motivo);
  };

  if (!vinculoMetaSocialConfere(req.cookies.get(NOME_DO_VINCULO_META_SOCIAL)?.value, estado.nonce, env.INTERNAL_SECRET)) {
    return recusouSemVinculo("retorno_nao_verificavel", "vinculo_ausente_ou_nao_confere");
  }
  const code = url.searchParams.get("code");
  if (!code) return recusouSemVinculo("retorno_incompleto");

  const admin = createAdminClient();
  if (!(await supportCallbackWriteAllowed(organizationId, userId, estado.authSessionId))) {
    return recusouSemVinculo("retorno_nao_verificavel", "suporte_sem_escrita");
  }
  if (!(await aindaAdministra(admin, organizationId, userId))) {
    return recusouSemVinculo("sem_permissao");
  }

  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    return recusouSemVinculo(
      "retorno_nao_verificavel",
      erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel",
    );
  }

  const cfg = await configMetaSocial();
  const app = plataforma === "instagram" ? cfg.instagram : cfg.messenger;
  if (!app) return falhou("nao_configurado");

  const redirectUri = redirectUriDe(caminhoDoCallback(plataforma));
  const ator: Ator = { userId, authSessionId: estado.authSessionId };

  try {
    // Cada conta concedida vira um canal: no Instagram, cada conta do portfólio
    // marcada no login (todas com o MESMO token, o do usuário do sistema); no
    // Messenger, cada Página (com o token dela).
    let contas: { conta: ContaDaMeta; token: string }[];
    let expiraEm: string | null = null;
    let autorizadorId: string | null;
    let empresaId: string | null = null;
    if (plataforma === "instagram") {
      const suat = await trocarCodigoLoginUnificado(app, code, redirectUri);
      const sistema = await usuarioDoSistema(suat.token);
      const concedidas = await contasInstagramConcedidas(suat.token);
      if (concedidas.length === 0) return falhou("nenhuma_conta_instagram");
      contas = concedidas.map((conta) => ({ conta, token: suat.token }));
      expiraEm = suat.expiraEmSegundos ? new Date(Date.now() + suat.expiraEmSegundos * 1000).toISOString() : null;
      // O /me do SUAT é o usuário do sistema de integração, não a pessoa: a
      // exclusão de dados casa por ele E pela conta (`exclusao.ts`).
      autorizadorId = sistema.id;
      empresaId = sistema.clientBusinessId;
    } else {
      const curto = await trocarCodigoMessenger(app, code, redirectUri);
      const longo = await tokenLongoMessenger(app, curto);
      const paginas = await paginasMessenger(longo);
      if (paginas.length === 0) return falhou("nenhuma_pagina");
      autorizadorId = await usuarioDoFacebook(longo);
      contas = paginas.map((p) => ({ conta: { id: p.id, nome: p.nome, usuario: null }, token: p.token }));
    }

    // A conta que estourar o limite do plano (ou estiver em outra organização)
    // não derruba as outras.
    let conectadas = 0;
    let recusadas = 0;
    let primeiraRecusa: MotivoDaVolta | null = null;
    for (const c of contas) {
      try {
        await conectarConta(admin, {
          organizationId,
          plataforma,
          conta: c.conta,
          token: c.token,
          expiraEm,
          ator,
          autorizadorId,
          empresaId,
        });
        conectadas += 1;
      } catch (err) {
        if (!(err instanceof ConexaoRecusada)) throw err;
        recusadas += 1;
        // Limite do plano tem precedência na mensagem: é o que a pessoa resolve.
        if (primeiraRecusa === null || err.motivo === "limite_do_plano") primeiraRecusa = err.motivo;
      }
    }
    if (primeiraRecusa && conectadas === 0) return falhou(primeiraRecusa);
    if (primeiraRecusa) {
      // Recusa PARCIAL: umas contas entraram, outras não. Dizer só "erro"
      // esconderia as que funcionam; dizer só "ok" esconderia as que faltam.
      await registrarFalha(primeiraRecusa, `parcial:${conectadas}/${conectadas + recusadas}`);
      return voltarParaConexoes({ meta_social: "parcial", n: conectadas, recusadas, motivo: primeiraRecusa });
    }
    return voltarParaConexoes({ meta_social: "ok", n: conectadas });
  } catch (err) {
    if (err instanceof ConexaoRecusada) return falhou(err.motivo);
    if (err instanceof ErroDaMeta) {
      logger.warn("[meta-social.callback] a Meta recusou", {
        organization_id: organizationId,
        etapa: err.etapa,
        status: err.status,
        codigo: err.codigoDaMeta,
      });
      return falhou("meta_recusou", err.etapa);
    }
    logger.error("[meta-social.callback] falha inesperada", {
      organization_id: organizationId,
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return falhou("falha_inesperada");
  }
}
