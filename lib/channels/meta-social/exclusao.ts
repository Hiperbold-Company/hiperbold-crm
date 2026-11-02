/**
 * Callback de exclusão de dados da Meta (quem remove o app do Instagram ou do
 * Facebook). A Meta manda `signed_request` = `<assinatura>.<carga>`, os dois em
 * base64url; a assinatura é HMAC-SHA256 da CARGA (o texto base64url, não o
 * JSON) com o segredo do app. Vale qualquer segredo da instalação — e qual
 * bateu diz de qual app veio o pedido.
 *
 * Três garantias além da assinatura:
 *   - FRESCOR: `issued_at` é obrigatório e vale por 24h. Um `signed_request`
 *     vazado não serve para disparar arquivamentos semanas depois.
 *   - IDEMPOTÊNCIA: um pedido aberto por `(rede, pessoa)` (índice único parcial
 *     da 0987). A reentrega devolve o MESMO código, sem linha nova e sem trilha
 *     nova; a reentrega de um pedido já cumprido (mesmo `issued_at`) também.
 *   - EXECUÇÃO: o pedido é cumprido na hora — toda conexão `meta_social` dessa
 *     rede autorizada por essa pessoa (ou cuja conta É essa pessoa) é arquivada
 *     pelo mesmo caminho do "Desconectar" (`arquivarConta`: tira a assinatura
 *     do webhook na Meta e apaga o token). Nada casou = cumprido sem efeito.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import type { PlataformaMetaSocial } from "./constantes";
import { CHAVE_DO_AUTORIZADOR, arquivarConta } from "./store";

/** Por quanto tempo um `signed_request` vale depois de emitido. */
export const VALIDADE_DO_PEDIDO_MS = 24 * 60 * 60 * 1000;
/** Folga para relógio adiantado da Meta (ou nosso). */
const FOLGA_DO_RELOGIO_MS = 5 * 60 * 1000;

export interface PedidoAssinado {
  userId: string;
  emitidoEm: string;
  /** O índice do segredo que conferiu (para dizer de qual app veio). */
  segredo: number;
}

export function lerSignedRequest(
  signed: string | null | undefined,
  segredos: readonly string[],
  agora: Date = new Date(),
): PedidoAssinado | null {
  if (!signed || signed.length > 4096) return null;
  const partes = signed.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const [assinaturaB64, carga] = partes;
  const recebida = Buffer.from(assinaturaB64!, "base64url");
  let indice = -1;
  segredos.forEach((s, i) => {
    if (!s) return;
    const esperada = createHmac("sha256", s).update(carga!, "utf8").digest();
    if (recebida.length === esperada.length && timingSafeEqual(recebida, esperada) && indice < 0)
      indice = i;
  });
  if (indice < 0) return null;
  let dado: Record<string, unknown>;
  try {
    dado = JSON.parse(Buffer.from(carga!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (dado.algorithm !== undefined && String(dado.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
  const userId = typeof dado.user_id === "string" || typeof dado.user_id === "number" ? String(dado.user_id) : "";
  if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return null;
  if (typeof dado.issued_at !== "number" || !Number.isFinite(dado.issued_at)) return null;
  const emitidoMs = dado.issued_at * 1000;
  if (emitidoMs > agora.getTime() + FOLGA_DO_RELOGIO_MS) return null;
  if (agora.getTime() - emitidoMs > VALIDADE_DO_PEDIDO_MS) return null;
  return { userId, emitidoEm: new Date(emitidoMs).toISOString(), segredo: indice };
}

interface LinhaDoPedido {
  id: string;
  confirmation_code: string;
  status: "received" | "completed";
}

export interface PedidoRegistrado {
  id: string;
  codigo: string;
  /** Linha nova agora (audita "recebido"); `false` = reentrega. */
  novo: boolean;
  /** Já cumprido antes (reentrega de pedido concluído): nada a executar. */
  concluido: boolean;
}

const COLUNAS_DO_PEDIDO = "id, confirmation_code, status";

async function pedidoAberto(
  admin: SupabaseClient,
  plataforma: PlataformaMetaSocial,
  userId: string,
): Promise<LinhaDoPedido | null> {
  const { data, error } = await admin
    .from("meta_data_deletion_requests")
    .select(COLUNAS_DO_PEDIDO)
    .eq("platform", plataforma)
    .eq("meta_user_id", userId)
    .eq("status", "received")
    .limit(1);
  if (error) throw new Error("meta_deletion_lookup_failed");
  return ((data ?? []) as LinhaDoPedido[])[0] ?? null;
}

/**
 * O pedido aberto de `(rede, pessoa)`, ou um novo. Reentrega do mesmo pedido já
 * cumprido (mesmo `issued_at`) devolve o código dele, sem linha nova.
 */
export async function registrarPedidoDeExclusao(
  admin: SupabaseClient,
  input: { plataforma: PlataformaMetaSocial; userId: string; emitidoEm: string },
): Promise<PedidoRegistrado> {
  const aberto = await pedidoAberto(admin, input.plataforma, input.userId);
  if (aberto) return { id: aberto.id, codigo: aberto.confirmation_code, novo: false, concluido: false };

  const { data: cumprido, error: erroDoCumprido } = await admin
    .from("meta_data_deletion_requests")
    .select(COLUNAS_DO_PEDIDO)
    .eq("platform", input.plataforma)
    .eq("meta_user_id", input.userId)
    .eq("issued_at", input.emitidoEm)
    .eq("status", "completed")
    .limit(1);
  if (erroDoCumprido) throw new Error("meta_deletion_lookup_failed");
  const repetido = ((cumprido ?? []) as LinhaDoPedido[])[0];
  if (repetido) return { id: repetido.id, codigo: repetido.confirmation_code, novo: false, concluido: true };

  const codigo = randomBytes(12).toString("hex");
  const { data, error } = await admin
    .from("meta_data_deletion_requests")
    .insert({
      confirmation_code: codigo,
      platform: input.plataforma,
      meta_user_id: input.userId,
      issued_at: input.emitidoEm,
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    // Duas entregas simultâneas: a outra criou o pedido aberto primeiro.
    const outro = await pedidoAberto(admin, input.plataforma, input.userId);
    if (outro) return { id: outro.id, codigo: outro.confirmation_code, novo: false, concluido: false };
  }
  if (error || !data) throw new Error("meta_deletion_insert_failed");
  return { id: (data as { id: string }).id, codigo, novo: true, concluido: false };
}

export interface ResultadoDaExclusao {
  /** Sessões arquivadas, com a organização de cada uma. */
  arquivadas: { organizationId: string; sessionId: string }[];
}

/**
 * Cumpre o pedido: arquiva toda conexão viva desta rede autorizada pela pessoa
 * (ou cuja conta é ela) e marca o pedido como concluído. Lança se o banco
 * falhar — o pedido fica aberto, e a reentrega da Meta tenta de novo.
 */
export async function executarPedidoDeExclusao(
  admin: SupabaseClient,
  pedido: { id: string; plataforma: PlataformaMetaSocial; userId: string },
  opcoes: { requestId?: string; arquivar?: typeof arquivarConta } = {},
): Promise<ResultadoDaExclusao> {
  const arquivar = opcoes.arquivar ?? arquivarConta;
  // cerca-canal: exclusao_pedida_pela_meta (tests/unit/canal-consulta-por-organizacao.test.ts)
  const { data: pelaConta, error: erroPelaConta } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", pedido.plataforma)
    .eq("meta_social_account_id", pedido.userId)
    .is("archived_at", null);
  if (erroPelaConta) throw new Error("meta_deletion_sessions_lookup_failed");
  const { data: peloAutorizador, error: erroPeloAutorizador } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", pedido.plataforma)
    .eq(`metadata->>${CHAVE_DO_AUTORIZADOR}`, pedido.userId)
    .is("archived_at", null);
  if (erroPeloAutorizador) throw new Error("meta_deletion_sessions_lookup_failed");

  const alvos = new Map<string, string>();
  for (const l of [...(pelaConta ?? []), ...(peloAutorizador ?? [])] as { id: string; organization_id: string }[]) {
    alvos.set(l.id, l.organization_id);
  }

  const arquivadas: ResultadoDaExclusao["arquivadas"] = [];
  for (const [sessionId, organizationId] of alvos) {
    // A organização vem da PRÓPRIA linha achada — e `arquivarConta` filtra por ela.
    const r = await arquivar(admin, organizationId, sessionId);
    if (!r) continue;
    arquivadas.push({ organizationId, sessionId });
    await audit({
      action: "meta.data_deletion_executed",
      organizationId,
      resourceType: "channel_session",
      resourceId: sessionId,
      requestId: opcoes.requestId ?? null,
      metadata: { plataforma: pedido.plataforma, pedido_id: pedido.id, desassinado: r.desassinado },
    });
  }

  const { error } = await admin
    .from("meta_data_deletion_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", pedido.id)
    .eq("status", "received");
  if (error) throw new Error("meta_deletion_complete_failed");
  return { arquivadas };
}
