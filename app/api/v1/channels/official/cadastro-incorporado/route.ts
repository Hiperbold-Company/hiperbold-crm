import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official/cadastro-incorporado: o que o navegador precisa
 *      para abrir o Cadastro Incorporado da Meta (`FB.login` com o `config_id`) e
 *      um `state` NOVO, de uso único, válido por 15 minutos.
 * POST /api/v1/channels/official/cadastro-incorporado: a volta do cadastro. Troca
 *      o `code` pelo token NO SERVIDOR, resolve a WABA e conecta o número pelo
 *      mesmo caminho do formulário manual (`conectarCanalOficial`).
 *
 * Migration 1014 (`platform_meta_app.whatsapp_config_id`, piso `.env`
 * `META_WHATSAPP_CONFIG_ID`). Doc da Meta:
 * https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 *
 * A ORGANIZAÇÃO VEM SÓ DA SESSÃO. O `state` só pode confirmar a organização e o
 * usuário da sessão (iguais, senão 403), e nada do corpo define organização. O
 * nonce do `state` é queimado ANTES da troca do código: repetir a mesma volta
 * (replay) recusa sem chegar à Meta.
 *
 * Várias conexões oficiais por organização (17/11/2026): `channel_session_id` no
 * corpo do POST diz qual conexão está sendo refeita (tem de ser desta organização,
 * senão 404, e o número escolhido tem de ser o dela, senão 422). Sem ele, decide o
 * número: mesmo número = mesma linha; número novo = conexão nova. A fase B passa o
 * id sempre que o cadastro for de uma conexão existente.
 *
 * Rota de cookie, como as demais de `/api/v1/channels`: o `proxy.ts` exige a
 * sessão, e por isso não há entrada em `lib/auth/public-paths.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mensagemDaRecusaDoPlano } from "@/lib/billing/planos/limite-de-conexoes";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { configDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado/config";
import {
  emitirEstadoDoCadastroIncorporado,
  verificarEstadoDoCadastroIncorporado,
} from "@/lib/channels/meta/cadastro-incorporado/estado";
import {
  escolherWaba,
  motivoDaFalhaDaMeta,
  trocarCodigo,
  wabaDoToken,
} from "@/lib/channels/meta/cadastro-incorporado/meta";
import { conectarCanalOficial, respostaDaFalhaDaConexaoOficial } from "@/lib/channels/meta/conectar-canal-oficial";
import { idDaConexaoOficialSchema } from "@/lib/channels/meta/sessao-oficial-viva";
import { lerEstadoDoNumero, sincronizarContatosDoApp } from "@/lib/channels/meta/registro-do-numero";
import { VERSAO_DA_GRAPH_SOCIAL } from "@/lib/channels/meta-social/constantes";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

const SO_DIGITOS = /^[0-9]{5,30}$/;

const conclusaoSchema = z.object({
  state: z.string().min(1).max(2048),
  // O código do `FB.login`: opaco, sem espaço.
  code: z.string().regex(/^\S{10,2048}$/),
  // Opcional no schema para a recusa do FINISH_ONLY_WABA ter mensagem própria;
  // sem ele a rota recusa logo abaixo, antes de qualquer efeito.
  phone_number_id: z.string().regex(SO_DIGITOS).optional(),
  waba_id: z.string().regex(SO_DIGITOS).optional(),
  nome: z.string().trim().min(1).max(80).optional(),
  evento: z.enum(["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_ONLY_WABA"]).optional(),
  channel_session_id: idDaConexaoOficialSchema.optional(),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;

  const cfg = await configDoCadastroIncorporado();
  if (!cfg) {
    return ok({ disponivel: false, motivo: "nao_configurado" }, { requestId, headers: NO_STORE });
  }

  // O id da sessão de login entra no state quando há (amarra a conclusão à mesma
  // sessão que pediu o início). Sem ele, a amarração por org + usuário continua.
  let authSessionId: string | undefined;
  try {
    authSessionId = await authenticatedSessionId();
  } catch {
    authSessionId = undefined;
    logger.warn("[cadastro-incorporado] state emitido sem sessão de login", { request_id: requestId });
  }

  let state: string;
  try {
    state = emitirEstadoDoCadastroIncorporado(
      { organizationId: authz.org.orgId, userId: authz.user.id, authSessionId },
      { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce: randomBytes(16).toString("hex") },
    );
  } catch (err) {
    return falhaInterna("internal_error", err, { requestId });
  }

  return ok(
    {
      disponivel: true,
      // `appId` e `configId` não são segredo: vão para o `FB.init`/`FB.login`.
      appId: cfg.appId,
      configId: cfg.configId,
      versaoDaGraph: VERSAO_DA_GRAPH_SOCIAL,
      state,
    },
    { requestId, headers: NO_STORE },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const idioma = authz.user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const parsed = conclusaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Id malformado é conexão que não existe aqui: o mesmo 404 do id de outra organização.
    if (parsed.error.issues.some((i) => i.path[0] === "channel_session_id")) {
      return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
    }
    return fail("invalid_request", t("A volta do cadastro da Meta veio incompleta. Clique em Conectar de novo."), 422, {
      requestId,
    });
  }
  const { state, code, phone_number_id, waba_id, nome, evento, channel_session_id } = parsed.data;
  if (!phone_number_id) {
    return fail(
      "numero_nao_escolhido",
      evento === "FINISH_ONLY_WABA"
        ? t("Escolha um número no cadastro da Meta")
        : t("A volta do cadastro da Meta veio incompleta. Clique em Conectar de novo."),
      422,
      { requestId },
    );
  }

  // ─── O state: deste usuário, desta organização, desta sessão, uma vez ─────
  const respostaDoEstadoInvalido = () =>
    fail("estado_invalido", t("O pedido de conexão venceu ou não é seu. Clique em Conectar de novo."), 403, {
      requestId,
    });
  const recusaDoEstado = (codigo: string) => {
    // Só o código da recusa vai ao log: nunca state, code nem token.
    logger.warn("[cadastro-incorporado] recusa de segurança", {
      request_id: requestId,
      organization_id: orgId,
      user_id: userId,
      recusa: codigo,
    });
    return respostaDoEstadoInvalido();
  };
  let estado: ReturnType<typeof verificarEstadoDoCadastroIncorporado>;
  try {
    estado = verificarEstadoDoCadastroIncorporado(state, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch (err) {
    return falhaInterna("internal_error", err, { requestId });
  }
  if (!estado) return recusaDoEstado("estado_invalido_ou_vencido");
  if (estado.organizationId !== orgId || estado.userId !== userId) return recusaDoEstado("estado_de_outra_organizacao_ou_usuario");
  if (estado.authSessionId) {
    let sessaoAtual: string | null = null;
    try {
      sessaoAtual = await authenticatedSessionId();
    } catch {
      sessaoAtual = null;
    }
    if (sessaoAtual !== estado.authSessionId) return recusaDoEstado("estado_de_outra_sessao_de_login");
  }

  const cfg = await configDoCadastroIncorporado();
  if (!cfg) {
    return fail("nao_configurado", t("O cadastro pela Meta não está configurado nesta instalação."), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  // O código vale UMA vez: o nonce é queimado ANTES da troca, na mesma tabela de
  // uso único do Google Agenda, Nuvemshop e canal social. 23505 = repetido;
  // qualquer outro erro também recusa, porque sem gravar não há uso único.
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: orgId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    if (erroDoNonce.code === "23505") return recusaDoEstado("nonce_repetido");
    return falhaInterna("internal_error", erroDoNonce, { requestId });
  }

  // ─── Código → token, no servidor ──────────────────────────────────────────
  let token: string;
  try {
    token = await trocarCodigo(cfg, code);
  } catch (err) {
    const motivo = motivoDaFalhaDaMeta(err);
    logger.warn("[cadastro-incorporado] troca do código recusada", { request_id: requestId, codigo: motivo.codigo });
    return fail(motivo.codigo, t(motivo.mensagem), 422, { requestId });
  }

  // ─── A WABA que vale ─────────────────────────────────────────────────────
  let alvos: string[] = [];
  try {
    alvos = await wabaDoToken(cfg, token);
  } catch (err) {
    // Sem a lista, vale a WABA do navegador (a validação adiante confere, com o
    // próprio token, que o número é dela); sem as duas, a regra recusa.
    logger.warn("[cadastro-incorporado] debug_token falhou", {
      request_id: requestId,
      codigo: motivoDaFalhaDaMeta(err).codigo,
    });
  }
  const waba = escolherWaba(alvos, waba_id);
  if (!waba.ok) {
    return fail(
      waba.erro,
      waba.erro === "waba_nao_autorizada"
        ? t("A conta do WhatsApp informada não está entre as que você autorizou na Meta. Clique em Conectar de novo.")
        : t("Não deu para saber qual conta do WhatsApp foi escolhida no cadastro da Meta. Clique em Conectar de novo."),
      422,
      { requestId },
    );
  }

  const conexao = await conectarCanalOficial({
    admin,
    orgId,
    userId,
    idioma,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: waba.wabaId,
    token,
    nome: nome ?? null,
    channelSessionId: channel_session_id ?? null,
    baseDoWebhook: basePublicaDoWebhookMeta(req),
    origem: "cadastro_incorporado",
  });

  if (!conexao.ok) {
    if (conexao.erro === "numero_em_outra_organizacao") {
      logger.warn("[cadastro-incorporado] recusa de segurança", {
        request_id: requestId,
        organization_id: orgId,
        user_id: userId,
        recusa: "numero_em_outra_organizacao",
      });
    }
    if (conexao.erro !== "gravacao") return respostaDaFalhaDaConexaoOficial(conexao, idioma, requestId);
    const { error } = conexao;
    const recusa = recusaDoPlano(error);
    if (recusa) {
      const mensagem = await mensagemDaRecusaDoPlano(recusa, admin, orgId, idioma);
      return fail("plano_limite_atingido", mensagem, STATUS_RECUSA_DO_PLANO, { requestId });
    }
    const limite = traduzirLimiteDoPlano(error, idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return falhaInterna("internal_error", error ?? "channel_session_write_failed", { requestId });
  }

  // O número recém-cadastrado pode precisar do registro (POST /register) para
  // enviar. Ler o estado é informativo: falha da leitura = `null`, não erro.
  let precisaRegistrar: boolean | null = null;
  try {
    const numero = await lerEstadoDoNumero({ phoneNumberId: phone_number_id, token });
    precisaRegistrar = numero.ok ? numero.precisaRegistrar : null;
  } catch {
    precisaRegistrar = null;
  }

  // Coexistência: a Meta exige a sincronização dos contatos do app depois do cadastro. Best effort:
  // falha não desfaz a conexão nem muda o status; só vai ao log (nunca o token).
  let sincronizacaoDoApp: boolean | null = null;
  if (evento === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    try {
      const sync = await sincronizarContatosDoApp({ phoneNumberId: phone_number_id, token });
      sincronizacaoDoApp = sync.ok;
      if (!sync.ok) {
        logger.warn("[cadastro-incorporado] sincronização dos contatos do app recusada", {
          request_id: requestId,
          organization_id: orgId,
          motivo: sync.motivo,
        });
      }
    } catch (err) {
      sincronizacaoDoApp = false;
      logger.warn("[cadastro-incorporado] sincronização dos contatos do app falhou", {
        request_id: requestId,
        organization_id: orgId,
        erro: err instanceof Error ? err.name : "desconhecido",
      });
    }
  }

  return ok(
    {
      connected: true,
      channel_session_id: conexao.channelSessionId,
      displayName: conexao.displayName,
      phoneNumber: conexao.phoneNumber,
      /** `registrado: false` NÃO desfaz a conexão: o canal envia; falta a entrega. */
      webhookRegistro: conexao.webhookRegistro,
      precisaRegistrar,
      /** Só na coexistência: `true` = a Meta aceitou, `false` = recusou; `null` = não se aplica. */
      sincronizacaoDoApp,
    },
    { requestId, headers: NO_STORE },
  );
}
