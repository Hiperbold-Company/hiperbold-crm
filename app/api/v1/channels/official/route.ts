import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 *
 * Várias conexões oficiais por organização (17/11/2026): o GET aceita `?id=` e o POST
 * `channel_session_id` no corpo. Id de outra organização, de outro canal ou excluído
 * = 404, sem dizer qual. Sem id, o GET mostra a oficial mais antiga e o POST decide
 * pelo número (mesmo número = mesma linha; número novo = conexão nova). A fase B
 * (tela em cartões) passa o id sempre.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok, falhaInterna } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mensagemDaRecusaDoPlano } from "@/lib/billing/planos/limite-de-conexoes";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { appDaMeta, appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import { metaGraphBase } from "@/lib/channels/meta/credentials";
import { conectarCanalOficial, respostaDaFalhaDaConexaoOficial } from "@/lib/channels/meta/conectar-canal-oficial";
import { buscarSessaoOficialViva, idDaConexaoNaQuery, idDaConexaoOficialSchema } from "@/lib/channels/meta/sessao-oficial-viva";
import { COLUNAS_DO_DESFECHO_DO_WEBHOOK } from "@/lib/channels/meta/webhook-da-sessao";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerCorDaConexao } from "@/lib/conexoes/cores";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  // Os ids da Meta são numéricos e viram caminho da Graph API: só dígitos (D-174).
  phone_number_id: z.string().regex(/^[0-9]{5,30}$/),
  waba_id: z.string().regex(/^[0-9]{5,30}$/),
  token: z.string().min(20),
  /** A conexão cuja credencial está sendo trocada (fase B). Ausente = decide o número. */
  channel_session_id: idDaConexaoOficialSchema.optional(),
});

interface DesfechoGravado {
  meta_webhook_override_uri: string | null;
  meta_webhook_override_erro: string | null;
  meta_webhook_override_em: string | null;
}

/**
 * O desfecho do registro do webhook desta sessão, lido em consulta PRÓPRIA.
 *
 * Separado do select principal de propósito: as três colunas chegam na migration
 * 0311, e num banco sem ela o select inteiro voltaria 42703 — a tela perderia o
 * canal (conectado, número, URL) por causa de um EXTRA. Aqui a ausência só significa
 * "estado do registro indisponível".
 */
async function lerDesfechoDoWebhook(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  channelSessionId: string,
): Promise<DesfechoGravado | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS_DO_DESFECHO_DO_WEBHOOK)
    .eq("organization_id", orgId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) return null;
  return data as DesfechoGravado | null;
}

/**
 * O token de verificação que esta tela pode MOSTRAR — e de onde vem o que vale.
 *
 * Isto lia `process.env.META_WEBHOOK_VERIFY_TOKEN` direto, e a migration 0257
 * tornou a leitura errada nos dois sentidos: com o App da Meta cadastrado pela
 * tela de administração, o handshake passa a conferir o token do BANCO, e esta
 * rota seguia mostrando o do `.env` (que a Meta recusaria) ou, sem `.env`,
 * "defina no servidor" para quem já tinha configurado tudo.
 *
 * O valor do banco NÃO é devolvido: ele é mostrado uma vez, na resposta da
 * action que o gera (`app/actions/settings/updateMetaApp.ts`), e aqui quem
 * responde é o admin de UM tenant, não quem administra a instalação. O do `.env`
 * continua sendo mostrado, como sempre foi — é o mesmo valor, na mesma rota.
 *
 * Por que "o que vale é igual ao do `.env`" basta para rotular a origem como
 * `ambiente`: o token em vigor (`lib/channels/meta/app.ts`) é OU o do banco OU o
 * do `.env` — o do banco só vale com o par inteiro decifrado; fora disso vale o
 * que o `.env` tiver, até pela metade. Então a igualdade só engana num caso: o
 * token do banco coincidir com o do `.env`. E o do banco ninguém escolhe — é
 * gerado pelo servidor com 32 bytes aleatórios —, então coincidir exige alguém
 * ter COPIADO o token gerado para o `.env`. Nesse caso o rótulo erra a origem,
 * mas o valor exibido é o mesmo que já está no `.env`, que esta rota sempre
 * mostrou: não sai nada que antes não saía.
 */
async function tokenDeVerificacaoParaATela(): Promise<{
  verifyToken: string | null;
  verifyTokenOrigem: "ambiente" | "instalacao" | null;
}> {
  const { verifyToken: emVigor } = await appDaMeta();
  if (!emVigor) return { verifyToken: null, verifyTokenOrigem: null };
  if (emVigor === appDaMetaDoAmbiente().verifyToken) {
    return { verifyToken: emVigor, verifyTokenOrigem: "ambiente" };
  }
  return { verifyToken: null, verifyTokenOrigem: "instalacao" };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const id = idDaConexaoNaQuery(new URL(req.url));
  if (id === null) return fail("not_found", traduzir("Conexão não encontrada.", authz.user.idioma), 404, { requestId });

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  const { data } = await buscarSessaoOficialViva<{
    id: string;
    meta_phone_number_id: string | null;
    meta_waba_id: string | null;
    meta_token_encrypted: string | null;
    phone_number: string | null;
    display_name: string | null;
    label_color: string | null;
    webhook_path_token: string | null;
    status: string | null;
  }>(
    admin,
    orgId,
    "id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, label_color, webhook_path_token, status",
    id,
  );
  if (id && !data) return fail("not_found", traduzir("Conexão não encontrada.", authz.user.idioma), 404, { requestId });

  const base = basePublicaDoWebhookMeta(req);
  const desfecho = data?.id ? await lerDesfechoDoWebhook(admin, orgId, data.id) : null;
  return ok({
    connected: Boolean(data),
    channel_session_id: data?.id ?? null,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data?.meta_token_encrypted),
    phoneNumberId: data?.meta_phone_number_id ?? null,
    wabaId: data?.meta_waba_id ?? null,
    /** Base pública da Graph API — para o operador reaproveitar em outro sistema. */
    endpoint: data ? metaGraphBase() : null,
    displayName: data?.display_name ?? null,
    /** Chave da cor da etiqueta (migration 1012); `null` = sem cor. */
    labelColor: lerCorDaConexao(data?.label_color),
    phoneNumber: data?.phone_number ?? null,
    status: data?.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: data
      ? {
          callbackUrl: `${base}/api/v1/webhooks/meta/${data.webhook_path_token}`,
          ...(await tokenDeVerificacaoParaATela()),
          // A porta para quem PODE abrir a tela da instalação — mesma regra do
          // link de `/admin/google` na Agenda. Para o admin de um tenant qualquer
          // o link seria um 404; a tela diz a ele quem procurar.
          configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
          // `smb_message_echoes`: o que a empresa manda pelo app WhatsApp Business
          // num número em coexistência. Sem coexistência a Meta não o envia, então
          // assinar é inofensivo para quem não usa.
          // `smb_app_state_sync`: o que a empresa faz no ENDEREÇO do app (contato
          // criado/editado), que vira cadastro no CRM. Mesma régua: sem
          // coexistência a Meta não envia.
          fields: [
            "messages",
            "message_template_status_update",
            "smb_message_echoes",
            "smb_app_state_sync",
          ],
        }
      : null,
    /**
     * E o que a instalação já fez SOZINHA (fatia F1): o webhook deste número está
     * registrado na Meta ou ainda não? `registrado: false` com `erro` é estado
     * esperado e não falha da conexão — o canal ENVIA normalmente; o que depende
     * disto é a ENTREGA. A tela mostra o motivo e oferece tentar de novo.
     */
    webhookRegistro: data
      ? {
          registrado:
            Boolean(desfecho?.meta_webhook_override_uri) && !desfecho?.meta_webhook_override_erro,
          url: desfecho?.meta_webhook_override_uri ?? null,
          erro: desfecho?.meta_webhook_override_erro ?? null,
          em: desfecho?.meta_webhook_override_em ?? null,
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Id malformado é conexão que não existe aqui: o mesmo 404 do id de outra organização.
    if (parsed.error.issues.some((i) => i.path[0] === "channel_session_id")) {
      return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
    }
    return fail("invalid_request", t("phone_number_id, waba_id e token são obrigatórios"), 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token, channel_session_id } = parsed.data;

  // Validar, cifrar, achar a conexão existente, reativar ou inserir e registrar o
  // webhook: o mesmo caminho do Cadastro Incorporado (migration 1014), num lugar só.
  const admin = createAdminClient();
  const conexao = await conectarCanalOficial({
    admin,
    orgId,
    userId: authz.user.id,
    idioma: authz.user.idioma,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: waba_id,
    token,
    channelSessionId: channel_session_id ?? null,
    baseDoWebhook: basePublicaDoWebhookMeta(req),
    origem: "manual",
  });

  if (!conexao.ok) {
    if (conexao.erro !== "gravacao") return respostaDaFalhaDaConexaoOficial(conexao, authz.user.idioma, requestId);
    const { error } = conexao;
    // Fase F3, decisão 3: cobre as DUAS escritas (o INSERT de canal novo e o
    // UPDATE de `reactivateChannelSession`), que contam contra o teto de
    // conexões. PT402 pelo `code`, nunca pelo texto do Postgres.
    const recusa = recusaDoPlano(error);
    if (recusa) {
      const mensagem = await mensagemDaRecusaDoPlano(recusa, admin, orgId, authz.user.idioma);
      return fail("plano_limite_atingido", mensagem, STATUS_RECUSA_DO_PLANO, { requestId });
    }
    // Limite do módulo de cobrança do upstream (spec cobrança §5), quando ligado.
    const limite = traduzirLimiteDoPlano(error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return falhaInterna("internal_error", error ?? "channel_session_write_failed", { requestId });
  }

  return ok({
    connected: true,
    channel_session_id: conexao.channelSessionId,
    displayName: conexao.displayName,
    phoneNumber: conexao.phoneNumber,
    /** `registrado: false` NÃO desfaz a conexão: o canal envia; falta a entrega. */
    webhookRegistro: conexao.webhookRegistro,
  });
}
