/**
 * Conectar o número oficial da Meta (Cloud API) a UMA organização: a parte que o
 * formulário manual (`POST /api/v1/channels/official`) e o Cadastro Incorporado
 * (`POST /api/v1/channels/official/cadastro-incorporado`, migration 1014) têm em
 * comum: validar → cifrar → achar a conexão deste número → reativar ou inserir →
 * reconhecer o erro do banco → registrar o webhook do número → auditar.
 *
 * As duas portas diferem só em COMO chegam ao trio (número, WABA, token): uma
 * recebe colado, a outra troca o código da Meta. O que acontece depois não pode
 * divergir: uma conexão pelo botão que pulasse a validação, a cifra ou a
 * ressurreição da linha arquivada seria um canal oficial de segunda classe.
 *
 * VÁRIAS conexões oficiais por organização (17/11/2026, decisão do dono do produto):
 * a identidade da conexão é o NÚMERO (`meta_phone_number_id`) dentro da organização.
 * Mesmo número já conectado aqui (ativo ou arquivado) → a MESMA linha recebe a
 * credencial nova (e volta à vida, se estava arquivada). Número novo → linha nova,
 * e quem decide se ela cabe é o gatilho do plano (`trg_billing_trava_channel_sessions`),
 * cuja recusa as rotas já traduzem. Conectar um segundo número NÃO toca no primeiro.
 *
 * `channelSessionId` (opcional) é a tela dizendo "estou trocando a credencial DESTA
 * conexão": ela tem de ser oficial, viva e desta organização (senão
 * `conexao_nao_encontrada`, 404) e o número informado tem de ser o dela (senão
 * `numero_diferente_da_conexao`, 422). As duas conferências vêm antes de falar com
 * a Meta e antes de gravar qualquer coisa.
 *
 * NUNCA devolve nem audita o token: a metadata da auditoria leva a origem e os
 * dois ids, que não são segredo.
 *
 * Quem traduz a falha em resposta HTTP é a rota (`respostaDaFalhaDaConexaoOficial`
 * para as recusas fixas). A recusa do PLANO cada rota traduz por conta própria,
 * que é o que `tests/unit/limite-do-plano-nas-rotas-de-canal.test.ts` cobra de
 * toda porta que cria canal.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { registrarWebhookDaSessao } from "@/lib/channels/meta/webhook-da-sessao";
import { buscarSessaoOficialViva } from "@/lib/channels/meta/sessao-oficial-viva";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type OrigemDaConexaoOficial = "manual" | "cadastro_incorporado";

/** O índice único GLOBAL do número ativo: um número ativo vive em UMA organização da instalação. */
export const INDICE_DO_NUMERO_ATIVO = "channel_sessions_meta_phone_number_id_ativo_unique";

export const MENSAGEM_NUMERO_EM_OUTRA_ORGANIZACAO =
  "Este número já está conectado em outra organização desta instalação. Desconecte lá antes de conectar aqui.";

/**
 * O que o cadastro incorporado devolve ao navegador quando a Meta recusa a
 * credencial. O texto cru da Meta (`error_data.details`/`message`) nunca sai
 * daqui por essa porta: vai só para o log, com o `request_id`. A porta manual
 * segue devolvendo o motivo, porque o operador que colou a credencial precisa dele.
 */
export const MENSAGEM_CREDENCIAL_RECUSADA_NO_CADASTRO =
  "A Meta recusou a credencial do número escolhido. Confira se o número terminou o cadastro e tente de novo.";

export const MENSAGEM_CONEXAO_NAO_ENCONTRADA = "Conexão não encontrada.";

export const MENSAGEM_NUMERO_DIFERENTE_DA_CONEXAO =
  "Este número não é o desta conexão. Para conectar outro número, use Adicionar conexão.";

export const MENSAGEM_CIFRA_INDISPONIVEL =
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado";

/**
 * Tipo largo o bastante para carregar `code`/`details`/`detail`: é isso que
 * `recusaDoPlano` lê para reconhecer o PT402 (fase F3, decisão 9). Um tipo só
 * com `message` esconderia o código e a recusa cairia sempre no 500 genérico.
 */
export interface ErroDaGravacao {
  message?: string | null;
  code?: string | null;
  details?: unknown;
  detail?: unknown;
}

export interface EntradaDaConexaoOficial {
  admin: ReturnType<typeof createAdminClient>;
  /** Da SESSÃO (cookie). Nunca do corpo da requisição. */
  orgId: string;
  userId: string;
  idioma: Idioma;
  requestId: string;
  phoneNumberId: string;
  wabaId: string;
  /** Em claro só aqui dentro; sai daqui cifrado e nunca volta. */
  token: string;
  /** A conexão que a tela diz estar atualizando (fase B). Ausente = decide o número. */
  channelSessionId?: string | null;
  /** Nome escolhido pelo operador; vazio = a regra de sempre (nome existente, depois o da Meta). */
  nome?: string | null;
  baseDoWebhook: string;
  origem: OrigemDaConexaoOficial;
}

export interface WebhookRegistroDaConexao {
  registrado: boolean;
  url: string | null;
  erro: string | null;
  em: string | null;
}

export type ResultadoDaConexaoOficial =
  | {
      ok: true;
      channelSessionId: string | null;
      displayName: string;
      phoneNumber: string | null;
      webhookRegistro: WebhookRegistroDaConexao | null;
    }
  | { ok: false; erro: "credencial_invalida"; motivo: string }
  | { ok: false; erro: "cifra_indisponivel" }
  | { ok: false; erro: "numero_em_outra_organizacao" }
  | { ok: false; erro: "conexao_nao_encontrada" }
  | { ok: false; erro: "numero_diferente_da_conexao" }
  | { ok: false; erro: "gravacao"; error: ErroDaGravacao };

export type FalhaFixaDaConexaoOficial = Exclude<ResultadoDaConexaoOficial, { ok: true } | { erro: "gravacao" }>;

/**
 * 23505 do índice GLOBAL do número, e só dele. A trava de (org, phone_number) da
 * 0106/0107 também devolve 23505, mas ela é DENTRO da organização; dizer "outra
 * organização" ali seria mentir. Por isso o nome do índice é conferido, e um
 * 23505 de outra trava segue o caminho de sempre (500 genérico).
 */
export function ehNumeroEmOutraOrganizacao(error: ErroDaGravacao | null | undefined): boolean {
  if (!error || error.code !== "23505") return false;
  const texto = [error.message, error.details, error.detail]
    .map((v) => (typeof v === "string" ? v : ""))
    .join(" ");
  return texto.includes(INDICE_DO_NUMERO_ATIVO);
}

/** As recusas que não dependem do plano viram resposta aqui, iguais nas duas rotas. */
export function respostaDaFalhaDaConexaoOficial(
  falha: FalhaFixaDaConexaoOficial,
  idioma: Idioma,
  requestId: string,
): NextResponse<ApiError> {
  const t = (texto: string) => traduzir(texto, idioma);
  switch (falha.erro) {
    case "credencial_invalida":
      return fail("invalid_request", falha.motivo, 422, { requestId });
    case "cifra_indisponivel":
      // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
      // recusar. O operador precisa saber que falta uma configuração de servidor.
      return fail("invalid_request", t(MENSAGEM_CIFRA_INDISPONIVEL), 422, { requestId });
    case "numero_em_outra_organizacao":
      return fail("numero_em_outra_organizacao", t(MENSAGEM_NUMERO_EM_OUTRA_ORGANIZACAO), 409, { requestId });
    case "conexao_nao_encontrada":
      // O mesmo 404 para id de outra organização, de outro canal ou excluído: não diz qual.
      return fail("not_found", t(MENSAGEM_CONEXAO_NAO_ENCONTRADA), 404, { requestId });
    case "numero_diferente_da_conexao":
      return fail("numero_diferente_da_conexao", t(MENSAGEM_NUMERO_DIFERENTE_DA_CONEXAO), 422, { requestId });
  }
}

export async function conectarCanalOficial(input: EntradaDaConexaoOficial): Promise<ResultadoDaConexaoOficial> {
  const { admin, orgId, userId, requestId, phoneNumberId, wabaId, token } = input;

  // A conexão que a tela diz estar atualizando: conferida ANTES da Meta e de gravar.
  if (input.channelSessionId) {
    const { data: alvo, error: erroDoAlvo } = await buscarSessaoOficialViva<{
      id: string;
      meta_phone_number_id: string | null;
    }>(admin, orgId, "id, meta_phone_number_id", input.channelSessionId);
    if (erroDoAlvo) return { ok: false, erro: "gravacao", error: erroDoAlvo };
    if (!alvo) return { ok: false, erro: "conexao_nao_encontrada" };
    if (alvo.meta_phone_number_id !== phoneNumberId) return { ok: false, erro: "numero_diferente_da_conexao" };
  }

  // VALIDA ANTES DE GRAVAR: a rota não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde.
  //
  // `wabaId` junto desde a fatia F1: a checagem do número sozinha aceita o par
  // trocado (número de uma conta, id de outra), e o registro do webhook logo abaixo
  // apontaria o override de um número que esta instalação não controla.
  const validacao = await validateMetaCredentials({ phoneNumberId, token, wabaId });
  if (!validacao.ok) {
    if (input.origem === "cadastro_incorporado") {
      logger.warn("[conectar-canal-oficial] credencial recusada no cadastro incorporado", {
        request_id: requestId,
        organization_id: orgId,
        motivo_da_meta: validacao.motivo,
      });
      return {
        ok: false,
        erro: "credencial_invalida",
        motivo: traduzir(MENSAGEM_CREDENCIAL_RECUSADA_NO_CADASTRO, input.idioma),
      };
    }
    return { ok: false, erro: "credencial_invalida", motivo: validacao.motivo };
  }

  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) return { ok: false, erro: "cifra_indisponivel" };

  // A conexão é o NÚMERO dentro da organização. A busca NÃO filtra `archived_at`:
  // um canal oficial excluído com ESTE número é exatamente o que esta conexão
  // precisa achar para trazer de volta. Ignorá-lo criaria uma segunda linha para o
  // mesmo número, e a velha continuaria segurando o par (org, número) na trava da
  // 0106. Se houver mais de uma (histórico), a viva vem primeiro, depois a mais antiga.
  const buscarExistente = (colunas: string, comArquivada: boolean) => {
    const q = admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId);
    const ordenada = comArquivada ? q.order(ARCHIVED_AT, { ascending: false, nullsFirst: true }) : q;
    return ordenada.order("created_at", { ascending: true }).limit(1).maybeSingle();
  };
  const { data: existenteRaw, error: erroDaBusca } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}, webhook_path_token, display_name`, true),
    () => buscarExistente("id, webhook_path_token, display_name", false),
  );
  // Busca que falhou NÃO é "não existe": seguir para o INSERT criaria uma segunda
  // linha para o mesmo número (ou esbarraria na trava do número) e esconderia a causa.
  if (erroDaBusca) return { ok: false, erro: "gravacao", error: erroDaBusca };
  const existente = existenteRaw as {
    id: string;
    archived_at?: string | null;
    webhook_path_token?: string | null;
    display_name?: string | null;
  } | null;

  const nomeEscolhido = input.nome?.trim() || null;
  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    // O nome do provedor só batiza a conexão; depois dela o nome é do operador
    // (Renomear), e salvar a credencial de novo não o apaga. Mesma regra do
    // `coalesce(display_name, ...)` do pareamento por QR. O nome digitado no
    // cadastro incorporado é escolha do operador, e por isso vence os dois.
    display_name: nomeEscolhido || existente?.display_name || (validacao.verifiedName ?? "Canal oficial"),
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) não serve de árbitro de `ON CONFLICT` aqui. Era DEFERRABLE
  // (medido ao criar a sessão de teste da Fase 3b, e o Postgres recusa
  // constraint deferível na inferência); a migration 0107 a trocou por um índice
  // único PARCIAL (`where archived_at is null`), que só seria inferível se a
  // cláusula repetisse o predicado, e o cliente do PostgREST não expõe isso.
  //
  // O update passa por `reactivateChannelSession` porque reconectar é
  // ressuscitar: o mesmo patch que devolve status, credencial e número tem que
  // devolver a linha à vida. Para o canal que já estava ativo é um no-op, e a
  // auditoria de volta sai de lá, junto da ressurreição.
  let sessaoId: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let error: ErroDaGravacao | null = null;

  if (existente) {
    ({ error } = await reactivateChannelSession(
      admin,
      {
        organizationId: orgId,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at ?? null,
      },
      linha,
      {
        userId,
        requestId,
        metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
      },
    ));
  } else {
    // `select("id, webhook_path_token")` porque o registro do webhook logo abaixo
    // precisa dos DOIS: o id para gravar o desfecho na mesma linha, e o token porque
    // é ele que compõe a URL que a Meta vai chamar.
    const inserida = await admin
      .from("channel_sessions")
      .insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      })
      .select("id, webhook_path_token")
      .maybeSingle();
    error = inserida.error;
    sessaoId = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (error) {
    // O mesmo número ativo em OUTRA organização desta instalação: antes caía no
    // 500 genérico, e o operador não tinha como saber que o número já estava em uso.
    if (ehNumeroEmOutraOrganizacao(error)) return { ok: false, erro: "numero_em_outra_organizacao" };
    return { ok: false, erro: "gravacao", error };
  }

  // ─── O webhook DESTE número, registrado pela própria instalação (fatia F1) ──
  // DEPOIS de gravar, nunca antes: o GET de verificação da Meta chega no instante
  // em que o override é registrado e procura a sessão pelo `webhook_path_token`.
  const webhook =
    sessaoId && webhookPathToken
      ? await registrarWebhookDaSessao({
          admin,
          organizationId: orgId,
          channelSessionId: sessaoId,
          phoneNumberId,
          wabaId,
          tokenCifrado: cifrado,
          webhookPathToken,
          base: input.baseDoWebhook,
          requestId,
        })
      : null;

  // `audit()` nunca lança (falha vira alerta, não bloqueia a conexão). Sem token:
  // a metadata é a origem e os dois ids da Meta, que não são segredo.
  await audit({
    action: "channel.official_connected",
    organizationId: orgId,
    actorUserId: userId,
    resourceType: "channel_session",
    resourceId: sessaoId,
    requestId,
    metadata: { origem: input.origem, phone_number_id: phoneNumberId, waba_id: wabaId },
  });

  return {
    ok: true,
    channelSessionId: sessaoId,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    webhookRegistro: webhook
      ? { registrado: webhook.registrado, url: webhook.url, erro: webhook.erro, em: webhook.em }
      : null,
  };
}
