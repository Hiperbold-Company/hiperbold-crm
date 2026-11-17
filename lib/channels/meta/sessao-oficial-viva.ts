/**
 * QUAL conexão oficial (WhatsApp Cloud / WABA) da organização uma rota está tratando.
 *
 * Desde 17/11/2026 a organização pode ter VÁRIAS conexões oficiais (uma por número). As rotas de
 * `/api/v1/channels/official/*` e a de modelos aceitam `channel_session_id` para dizer qual; a busca é
 * SEMPRE por id + `organization_id` da sessão de login + provider oficial + não arquivada. Um id de
 * outra organização, de outro provider ou já excluído cai no mesmo `null`, e a rota responde 404 sem
 * dizer qual dos três foi.
 *
 * Sem id, vale a conexão oficial MAIS ANTIGA da organização: é o comportamento da tela de hoje, que
 * ainda não manda o id. A fase B (tela em cartões) passa o id sempre. `order` + `limit(1)` e não
 * `maybeSingle` puro: com duas oficiais, o `maybeSingle` sozinho volta erro e a tela diria "não conectado".
 *
 * O cliente é de servidor e ignora a RLS: por isso o filtro de organização é explícito aqui.
 */
import type { NextResponse } from "next/server";
import { z } from "zod";

import { fail, falhaInterna } from "@/lib/api/wrappers";
import { ARCHIVED_AT, queryTolerantToMissingArchived, type DbErrorLike } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { createAdminClient } from "@/lib/supabase/admin";

/** O id da conexão, quando a tela diz qual. */
export const idDaConexaoOficialSchema = z.string().uuid();

/**
 * Lê o id da conexão da query (`?id=` ou `?channel_session_id=`).
 * `undefined` = ausente (vale a mais antiga); `null` = presente e inválido (a rota responde 404).
 */
export function idDaConexaoNaQuery(url: URL): string | undefined | null {
  // String vazia conta como ausente ANTES do `??`: `?id=&channel_session_id=<uuid>` não pode esconder o segundo.
  const doId = url.searchParams.get("id");
  const bruto = doId !== null && doId !== "" ? doId : url.searchParams.get("channel_session_id");
  if (bruto === null || bruto === "") return undefined;
  const parsed = idDaConexaoOficialSchema.safeParse(bruto);
  return parsed.success ? parsed.data : null;
}

export async function buscarSessaoOficialViva<T>(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  colunas: string,
  channelSessionId?: string | null,
): Promise<{ data: T | null; error: DbErrorLike | null }> {
  const consultar = () => {
    const q = admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META);
    // Com id, ele decide; sem id, a mais antiga (o comportamento de antes da fase B).
    return channelSessionId ? q.eq("id", channelSessionId) : q.order("created_at", { ascending: true }).limit(1);
  };
  const { data, error } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );
  return { data: (data as T | null) ?? null, error: error ?? null };
}

/**
 * A organização tem MAIS DE UMA conexão oficial viva? (`limit(2)`: só interessa saber se passa de uma.)
 * Mesma população de `buscarSessaoOficialViva`: id da organização explícito, provider oficial, não arquivada.
 * LANÇA quando a consulta falha; as rotas respondem 500 (`recusaSeConexaoOficialAmbigua` converte).
 */
export async function temMaisDeUmaConexaoOficialViva(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<boolean> {
  // Erro da consulta NÃO vira "uma só": a rota que decide por esta resposta responderia sobre a conexão errada.
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .limit(2);
  const { data, error } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null),
    () => consultar(),
  );
  if (error) throw new Error(`consulta_das_conexoes_oficiais_falhou: ${error.message ?? error.code ?? "erro"}`);
  return (data?.length ?? 0) > 1;
}

/**
 * Rota MUTANTE sem `channel_session_id`: com mais de uma conexão oficial viva, "a mais antiga" seria um
 * palpite sobre qual número registrar, reconfigurar ou sincronizar. Devolve a resposta 422 a enviar, ou
 * `null` quando pode seguir (id informado, ou uma conexão só, como antes da fase B). GET não usa isto:
 * leitura continua caindo na mais antiga.
 */
export async function recusaSeConexaoOficialAmbigua(input: {
  admin: ReturnType<typeof createAdminClient>;
  organizationId: string;
  channelSessionId?: string | null;
  idioma?: Idioma;
  requestId?: string;
}): Promise<NextResponse | null> {
  if (input.channelSessionId) return null;
  let maisDeUma: boolean;
  try {
    maisDeUma = await temMaisDeUmaConexaoOficialViva(input.admin, input.organizationId);
  } catch (err) {
    return falhaInterna("internal_error", err, { requestId: input.requestId });
  }
  if (!maisDeUma) return null;
  return fail(
    "conexao_oficial_ambigua",
    traduzir(
      "Esta organização tem mais de uma conexão oficial. Abra a conexão certa em Conexões e tente de novo.",
      input.idioma ?? "pt-BR",
    ),
    422,
    { requestId: input.requestId },
  );
}
