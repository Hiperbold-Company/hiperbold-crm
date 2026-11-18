/**
 * TODAS as conexões vivas da organização, no formato do CARTÃO da tela de Conexões (fase B).
 *
 * Quem chama: `GET /api/v1/channels/conexoes` (sessão OU token `dsk_…`, piso `manager`, o mesmo da tela).
 *
 * Diferente de `listar-conexoes.ts` (a lista do seletor do inbox, de qualquer membro): aqui entram todos os
 * providers, inclusive voz, e cada linha diz o TIPO legível, o status normalizado e, na oficial, a conta
 * (WABA), o número na Meta e se o webhook está registrado.
 *
 * ⚠️ SEM SEGREDO, POR CONSTRUÇÃO: as colunas pedidas são listas fixas (`COLUNAS_*`), sem token, segredo de
 * webhook, `webhook_path_token` nem `metadata`. Quem acrescenta coluna aqui responde por
 * `tests/unit/varias-contas-oficiais-na-mesma-organizacao.test.ts` (grupo (d)), que reprova a saída com qualquer campo de credencial.
 *
 * ⚠️ A organização é a que a porta resolveu (sessão/linha do token), com filtro explícito: o cliente de uma
 * chave é service role e BYPASSA a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived, type DbErrorLike } from "@/lib/channels/archived";
import {
  CHANNEL_PROVIDER_DATAFY,
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_META_SOCIAL,
  CHANNEL_PROVIDER_UAZAPI,
  CHANNEL_PROVIDER_WAHA,
  CHANNEL_PROVIDER_ZERNIO,
} from "@/lib/channels/capabilities";
import { plataformaDaConexao } from "@/lib/channels/listar-conexoes";

/** O que existe em qualquer banco com canal oficial (0144). */
const COLUNAS_BASICAS =
  "id, provider, display_name, phone_number, status, created_at, meta_waba_id, meta_phone_number_id";
/** Extras de migrations posteriores (canal social, desfecho do webhook da 0311): sem elas, o cartão sai igual. */
const COLUNAS_EXTRAS = "meta_social_platform, meta_social_username, meta_webhook_override_uri, meta_webhook_override_erro";

export type TipoDaConexao = "whatsapp_oficial" | "whatsapp_qr" | "instagram" | "messenger" | "outros";
export type StatusDaConexao = "conectado" | "desconectado" | "precisa_atencao";
export type PareamentoDaConexao = "instancia" | "sessao" | null;

export interface CartaoDaConexao {
  id: string;
  provider: string;
  tipo: TipoDaConexao;
  /** Só na oficial: `meta` (Cloud API direta) ou `parceiro` (WABA por intermediário). */
  via: "meta" | "parceiro" | null;
  nome: string | null;
  /** Telefone (WhatsApp) ou @usuário (rede social). */
  numero_ou_handle: string | null;
  status: StatusDaConexao;
  status_bruto: string;
  created_at: string;
  /**
   * Só na conexão por QR: por qual caminho ela se reconecta e se remove. `instancia` = rotas de
   * `/api/v1/channels/instancia`; `sessao` = rotas de `/api/v1/channel-sessions/[id]` (reconnect,
   * qr, pairing-code, DELETE). `null` nos demais. A tela decide por aqui, sem nomear provider.
   */
  pareamento: PareamentoDaConexao;
  /** Só na oficial; `null` nos demais. */
  oficial: { waba_id: string | null; meta_phone_number_id: string | null; webhook_registrado: boolean } | null;
}

const PROVIDERS_OFICIAIS_POR_PARCEIRO: readonly string[] = [CHANNEL_PROVIDER_ZERNIO, CHANNEL_PROVIDER_DATAFY];
const PROVIDERS_POR_QR: readonly string[] = [CHANNEL_PROVIDER_WAHA, CHANNEL_PROVIDER_UAZAPI];

/** O caminho de reconectar e remover da conexão por QR (ver `CartaoDaConexao.pareamento`). */
export function pareamentoDaConexao(provider: string): PareamentoDaConexao {
  if (provider === CHANNEL_PROVIDER_WAHA) return "sessao";
  if (provider === CHANNEL_PROVIDER_UAZAPI) return "instancia";
  return null;
}

export function tipoDaConexao(provider: string, metaSocialPlatform: unknown): { tipo: TipoDaConexao; via: CartaoDaConexao["via"] } {
  if (provider === CHANNEL_PROVIDER_META) return { tipo: "whatsapp_oficial", via: "meta" };
  if (PROVIDERS_OFICIAIS_POR_PARCEIRO.includes(provider)) return { tipo: "whatsapp_oficial", via: "parceiro" };
  if (PROVIDERS_POR_QR.includes(provider)) return { tipo: "whatsapp_qr", via: null };
  const plataforma = plataformaDaConexao(provider, metaSocialPlatform);
  if (plataforma === "instagram" || plataforma === "messenger") return { tipo: plataforma, via: null };
  return { tipo: "outros", via: null };
}

/**
 * WORKING = conectado; STARTING/SCAN_QR_CODE = precisa de atenção (alguém tem de ler o QR ou esperar subir);
 * STOPPED/FAILED = desconectado. A oficial WORKING com o registro do webhook recusado também pede atenção:
 * ela envia, mas não recebe.
 */
export function statusDaConexao(statusBruto: string, webhookComErro: boolean): StatusDaConexao {
  switch (statusBruto) {
    case "WORKING":
      return webhookComErro ? "precisa_atencao" : "conectado";
    case "STARTING":
    case "SCAN_QR_CODE":
      return "precisa_atencao";
    default:
      return "desconectado";
  }
}

function colunaAusente(error: DbErrorLike | null): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204");
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function cartaoDaLinha(linha: Record<string, unknown>): CartaoDaConexao {
  const provider = String(linha.provider ?? "");
  const { tipo, via } = tipoDaConexao(provider, linha.meta_social_platform);
  const statusBruto = String(linha.status ?? "");
  const ehOficialDireta = provider === CHANNEL_PROVIDER_META;
  const erroDoWebhook = texto(linha.meta_webhook_override_erro);
  const usuarioSocial = texto(linha.meta_social_username);
  return {
    id: String(linha.id),
    provider,
    tipo,
    via,
    nome: texto(linha.display_name),
    numero_ou_handle:
      provider === CHANNEL_PROVIDER_META_SOCIAL && usuarioSocial
        ? usuarioSocial.startsWith("@") ? usuarioSocial : `@${usuarioSocial}`
        : texto(linha.phone_number),
    status: statusDaConexao(statusBruto, ehOficialDireta && erroDoWebhook !== null),
    status_bruto: statusBruto,
    pareamento: pareamentoDaConexao(provider),
    created_at: String(linha.created_at ?? ""),
    oficial:
      tipo === "whatsapp_oficial"
        ? {
            waba_id: texto(linha.meta_waba_id),
            meta_phone_number_id: texto(linha.meta_phone_number_id),
            // Mesma régua do GET de `/channels/official`: há URL registrada e nenhum erro.
            webhook_registrado: ehOficialDireta && texto(linha.meta_webhook_override_uri) !== null && erroDoWebhook === null,
          }
        : null,
  };
}

export async function listarConexoesEmCartoes(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ data: CartaoDaConexao[] | null; error: DbErrorLike | null; schemaOutdated: boolean }> {
  const consultar = (colunas: string) =>
    queryTolerantToMissingArchived(
      () =>
        supabase
          .from("channel_sessions")
          .select(colunas)
          .eq("organization_id", organizationId)
          .is(ARCHIVED_AT, null)
          .order("created_at", { ascending: true }),
      () =>
        supabase
          .from("channel_sessions")
          .select(colunas)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true }),
    );
  let r = await consultar(`${COLUNAS_BASICAS}, ${COLUNAS_EXTRAS}`);
  let schemaOutdated = r.schemaOutdated;
  // Banco sem uma das colunas extras: a lista sai com o básico (rede social e webhook ficam sem dado).
  if (colunaAusente(r.error)) {
    r = await consultar(COLUNAS_BASICAS);
    schemaOutdated = true;
  }
  if (r.error) return { data: null, error: r.error, schemaOutdated };
  const linhas = (r.data ?? []) as unknown as Record<string, unknown>[];
  return { data: linhas.map(cartaoDaLinha), error: null, schemaOutdated: schemaOutdated || r.schemaOutdated };
}
