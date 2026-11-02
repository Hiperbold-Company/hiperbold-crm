/**
 * Callback de exclusão de dados da Meta (quem remove o app do Instagram ou do
 * Facebook). A Meta manda `signed_request` = `<assinatura>.<carga>`, os dois em
 * base64url; a assinatura é HMAC-SHA256 da CARGA (o texto base64url, não o
 * JSON) com o segredo do app. Vale qualquer segredo da instalação — e qual
 * bateu diz de qual app veio o pedido.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PlataformaMetaSocial } from "./constantes";

export interface PedidoAssinado {
  userId: string;
  emitidoEm: string | null;
  /** O índice do segredo que conferiu (para dizer de qual app veio). */
  segredo: number;
}

export function lerSignedRequest(
  signed: string | null | undefined,
  segredos: readonly string[],
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
  if (!userId) return null;
  const emitido = typeof dado.issued_at === "number" ? new Date(dado.issued_at * 1000).toISOString() : null;
  return { userId, emitidoEm: emitido, segredo: indice };
}

export async function registrarPedidoDeExclusao(
  admin: SupabaseClient,
  input: { plataforma: PlataformaMetaSocial; userId: string; emitidoEm: string | null },
): Promise<string> {
  const codigo = randomBytes(12).toString("hex");
  const { error } = await admin.from("meta_data_deletion_requests").insert({
    confirmation_code: codigo,
    platform: input.plataforma,
    meta_user_id: input.userId,
    issued_at: input.emitidoEm,
  });
  if (error) throw new Error("meta_deletion_insert_failed");
  return codigo;
}
