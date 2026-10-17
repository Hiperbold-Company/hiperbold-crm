/**
 * POST /api/v1/webhooks/channel/[token] — entrada por token, para qualquer canal.
 *
 * ─── Por que o caminho NÃO cita o canal ─────────────────────────────────────
 *
 * A família de rotas do canal por QR carrega o nome do provider na URL, e está
 * na lista de dívida do `lint:channels` por isso — sair de lá exigiria mudar
 * uma URL que já está configurada em instalação de gente. Uma rota NOVA não
 * precisa nascer devendo: o token identifica a sessão, a sessão diz qual é o
 * canal, e o caminho fica neutro. Canal seguinte entra sem uma quarta família
 * de URLs.
 *
 * ─── Por que esta rota é tão curta ──────────────────────────────────────────
 *
 * Ela não sabe de quem é o payload. Resolve o token, decifra o segredo e
 * entrega tudo a `handleInboundWebhook` — a verificação de assinatura e a
 * leitura moram lá porque o esquema é do CANAL (header, algoritmo e formato
 * mudam por provider). A primeira versão desta rota fazia isso aqui e o
 * `lint:channels` reprovou, que é a catraca funcionando: uma rota que verifica
 * assinatura precisa perguntar qual provider é.
 *
 * ─── O 200 que evita a tempestade ──────────────────────────────────────────
 *
 * Evento que não interessa (outro tipo, eco do nosso próprio envio, outra
 * plataforma) responde 200, não 4xx: o provider reentrega o que não recebeu
 * 200, e recusar um payload que nunca vai servir faria a reentrega durar para
 * sempre. 500 fica reservado para falha de ESCRITA — aí a reentrega é o que
 * queremos, porque o evento era bom e nós é que não gravamos.
 */
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  abrirArquivoDoWebhook,
  fecharArquivoDoWebhook,
} from "@/lib/channels/arquivo-de-webhook";
import { acceptsInboundWebhook, handleInboundWebhook, verifyInboundWebhookSignature, inboundPayloadBelongsToSession } from "@/lib/channels/inbound";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { lerCorpoDaRequisicao } from "@/lib/http/corpo-com-limite";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Teto do corpo de uma entrega (pode trazer mídia inline em canal que a envia). */
const TETO_CORPO_BYTES = 5 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  // Token curto nunca foi emitido por nós. 404 e não 401: quem varre URLs não
  // precisa saber que a rota existe.
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const admin = createAdminClient();

  // `CHANNEL_SESSION_REF_COLUMNS` já traz a coluna de ref de TODO canal (a
  // mesma lista que o resto do repositório usa para rotear envio, ver
  // `lib/channels/session-ref.ts`): a rota pede o conjunto genérico, nunca
  // nomeia qual coluna é de qual canal.
  const { data } = await queryTolerantToMissingArchived(
    () =>
      admin
        .from("channel_sessions")
        .select(
          `id, organization_id, display_name, phone_number, webhook_secret_encrypted, ${CHANNEL_SESSION_REF_COLUMNS}, ${ARCHIVED_AT}`,
        )
        .eq("webhook_path_token", token)
        .maybeSingle(),
    () =>
      admin
        .from("channel_sessions")
        .select(
          `id, organization_id, display_name, phone_number, webhook_secret_encrypted, ${CHANNEL_SESSION_REF_COLUMNS}`,
        )
        .eq("webhook_path_token", token)
        .maybeSingle(),
  );

  const linha = data as {
    id: string;
    organization_id: string;
    provider: string;
    display_name: string | null;
    phone_number: string | null;
    webhook_secret_encrypted: unknown;
    archived_at?: string | null;
  } | null;

  if (!linha) return fail("not_found", "unknown webhook token", 404, { requestId });

  // ACHADO 3: o identificador da sessão no provider, resolvido pela MESMA
  // função que o resto do repositório usa (pergunta a capacidade, não nomeia
  // a coluna). `handleInboundWebhook`/`inboundPayloadBelongsToSession`, do
  // lado de dentro do seam, sabem o que fazer com ele por canal.
  const sessao = { ...linha, session_ref: resolveSessionRef(data as ChannelSessionRef) };

  // Canal arquivado não ingere: o usuário mandou excluí-lo, e aceitar evento em
  // voo ressuscitaria a conversa no inbox com o operador sem poder responder.
  if (sessao.archived_at) {
    return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
  }

  if (!acceptsInboundWebhook(sessao.provider)) {
    return fail("invalid_request", "provider_mismatch", 400, { requestId });
  }

  // Teto de tamanho ANTES de ler: `req.text()` lê tudo o que o remetente mandar, e o
  // token desta rota vai na URL cadastrada em painel de terceiro.
  const corpoLido = await lerCorpoDaRequisicao(req, TETO_CORPO_BYTES);
  if (!corpoLido.ok) {
    logger.warn("[webhook-canal] corpo acima do teto", {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      provider: sessao.provider,
      request_id: requestId,
    });
    return fail("payload_too_large", "request body too large", 413, { requestId });
  }
  const rawBody = corpoLido.texto;

  const cifrado = sessao.webhook_secret_encrypted;
  const secret = cifrado ? await decryptWebhookSecret(admin, cifrado as string) : null;

  // D-043: `verifyInboundWebhookSignature` lê "exigir assinatura no webhook" da
  // MEMÓRIA do processo, de forma síncrona. Sem carregar a linha da instalação
  // aqui, um processo recém-subido responde com o piso do `.env` até alguém
  // abrir outra tela que a carregue, e a escolha feita em /admin/sistema não
  // valeria para a entrada de mensagens. Mesmo conserto já aplicado às rotas
  // de webhook por token do outro transporte de canal; o memo de 30s faz
  // disto no máximo uma leitura por janela, e nunca lança.
  await carregarComportamentoDaInstalacao();

  // ─── A assinatura é conferida ANTES de o corpo ir para o arquivo ───────────
  //
  // O corpo cru só é arquivado depois que a assinatura conferiu: quem conhece apenas
  // o TOKEN (público o bastante para estar numa URL) não pode escrever payload
  // arbitrário, de até o teto, na tabela de arquivo. A recusa continua deixando
  // rastro de si mesma — era o conserto de uma auditoria anterior, e uma recusa de
  // segurança sem rastro é pior que não ter a recusa —, mas o rastro é o fato (qual
  // conexão, quando, quantos bytes, quais cabeçalhos), não o conteúdo.
  if (!verifyInboundWebhookSignature(sessao.provider, rawBody, req.headers, secret)) {
    const arquivoDaRecusa = await abrirArquivoDoWebhook(admin, {
      organizationId: sessao.organization_id,
      channelSessionId: sessao.id,
      provider: sessao.provider,
      rawBody: "",
      corpoOmitido: { motivo: "assinatura recusada", bytes: Buffer.byteLength(rawBody, "utf8") },
      headers: req.headers,
    });
    await fecharArquivoDoWebhook(admin, arquivoDaRecusa, {
      status: "error",
      validSignature: false,
      erro: "bad_signature",
    });
    // E DEIXA RASTRO NO LOG, que é onde quem opera olha primeiro. `warn` e não
    // `error`: uma tentativa isolada não é incidente, mas uma sequência delas é
    // — e sem esta linha nem a sequência aparecia.
    logger.warn("[webhook-canal] assinatura recusada", {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      provider: sessao.provider,
      request_id: requestId,
    });
    return fail("unauthorized", "bad_signature", 401, { requestId });
  }

  // O corpo cru vai para o arquivo ANTES de qualquer processamento: se o processo
  // morrer no meio — exceção, OOM, deploy no instante errado — o payload continua
  // gravado, que é justamente quando alguém vai querer lê-lo.
  const arquivo = await abrirArquivoDoWebhook(admin, {
    organizationId: sessao.organization_id,
    channelSessionId: sessao.id,
    provider: sessao.provider,
    rawBody,
    headers: req.headers,
  });

  if (!await inboundPayloadBelongsToSession(admin, { session: sessao, rawBody, headers: req.headers, secret })) {
    // Assinatura BOA, conta errada: `validSignature: true` de propósito. Marcar
    // `false` aqui mandaria quem investiga procurar um problema de segredo que
    // não existe — o segredo está certo, o evento é que é de outra conta.
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: true,
      erro: "evento_de_outra_conta",
    });
    return ok({ status: "ignored", reason: "evento_de_outra_conta" }, { requestId });
  }

  try {
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody,
      headers: req.headers,
      secret,
    });

    if (r.ok) {
      await fecharArquivoDoWebhook(admin, arquivo, {
        status: "processed",
        validSignature: true,
        // O desfecho do seam vai junto: é ele que distingue "ingerido" de
        // "ignorado por falta de identidade" quando alguém for contar depois.
        erro: typeof r.body.reason === "string" ? r.body.reason : null,
      });
      return ok(r.body, { requestId });
    }

    const status = r.code === "unauthorized" ? 401 : 400;
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      // `false` SÓ quando a recusa foi por assinatura. Um payload bem assinado
      // que o parser recusou não é problema de segredo, e marcá-lo como se
      // fosse mandaria quem investiga procurar no lugar errado.
      validSignature: r.code === "unauthorized" ? false : null,
      erro: r.message,
    });
    return fail(
      r.code === "unauthorized" ? "unauthorized" : "invalid_request",
      r.message,
      status,
      { requestId },
    );
  } catch (err) {
    // O motivo real fica no arquivo e no log, que são nossos; a resposta ao provedor
    // (quem sabe o token e errou algo) leva só um código genérico — `err.message`
    // de uma exceção de ingestão pode citar tabela, coluna e valor.
    const detalhe = err instanceof Error ? err.message : "ingest_failed";
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: null,
      erro: detalhe,
    });
    logger.error("[webhook-canal] ingestão falhou", {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      provider: sessao.provider,
      request_id: requestId,
      detail: detalhe.slice(0, 200),
    });
    return fail("internal_error", "ingest_failed", 500, { requestId });
  }
}
