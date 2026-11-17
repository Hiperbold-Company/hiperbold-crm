import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/bug-reports — o relato do botão "Relatar problema" (migration 1018).
 *
 * Multipart: `description` (10 a 2000 caracteres), `context` (JSON: tela, user agent, viewport,
 * idioma, últimos erros do console) e `screenshot` opcional (WebP ou PNG, até 3 MB, conferido
 * pela assinatura dos bytes).
 *
 * Só sessão, qualquer papel (`viewer` para cima). A organização vem da sessão; um
 * `organization_id` no corpo não é lido. O print sobe para o bucket privado `bug-reports` pelo
 * service role, no caminho `<organization_id>/<id>.webp`; a linha entra pelo client da SESSÃO,
 * para a RLS de insert (só na própria organização, como o próprio usuário) valer também aqui.
 * Sem `.select()` depois do insert: `authenticated` não lê `bug_reports`.
 *
 * 10 relatos por usuário por hora (Upstash, com o contador em memória quando não há Redis).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import {
  BUCKET_DOS_RELATOS,
  ContextoDoRelatoSchema,
  DescricaoSchema,
  PRINT_MAX_BYTES,
  RELATOS_POR_HORA,
  caminhoDoPrint,
  farejarPrint,
} from "@/lib/relatos/regras";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const JANELA_SEG = 3600;
/** Folga do multipart sobre o print: descrição, contexto e as fronteiras. */
const FOLGA_DO_CORPO = 64 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "bug_reports" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const limite = await checkRateLimit(`bug-reports:user:${userId}`, RELATOS_POR_HORA, JANELA_SEG);
  if (!limite.allowed) {
    const fimDaJanela = ((limite.window_start ?? Math.floor(Date.now() / (JANELA_SEG * 1000))) + 1) * JANELA_SEG;
    const espera = Math.max(1, fimDaJanela - Math.floor(Date.now() / 1000));
    return fail("rate_limited", t("Muitos relatos em pouco tempo. Tente de novo mais tarde."), 429, {
      requestId,
      headers: { "Retry-After": String(espera) },
    });
  }

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > PRINT_MAX_BYTES + FOLGA_DO_CORPO) {
    return fail("validation_failed", t("O print precisa ter até 3 MB."), 400, { requestId });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return fail("validation_failed", t("Dados inválidos."), 400, { requestId });

  const descricao = DescricaoSchema.safeParse(form.get("description"));
  if (!descricao.success) {
    return fail("validation_failed", t("Descreva o problema com 10 a 2000 caracteres."), 400, { requestId });
  }

  const contextoBruto = form.get("context");
  let contextoJson: unknown = {};
  if (typeof contextoBruto === "string" && contextoBruto.length > 0) {
    try {
      contextoJson = JSON.parse(contextoBruto);
    } catch {
      return fail("validation_failed", t("Dados inválidos."), 400, { requestId });
    }
  }
  const contexto = ContextoDoRelatoSchema.safeParse(contextoJson);
  if (!contexto.success) return fail("validation_failed", t("Dados inválidos."), 400, { requestId });

  const relatoId = randomUUID();
  let caminho: string | null = null;
  let bytes: Uint8Array | null = null;
  let tipo: ReturnType<typeof farejarPrint> = null;
  const arquivo = form.get("screenshot");
  if (arquivo !== null) {
    if (!(arquivo instanceof File)) return fail("validation_failed", t("Dados inválidos."), 400, { requestId });
    if (arquivo.size > PRINT_MAX_BYTES) {
      return fail("validation_failed", t("O print precisa ter até 3 MB."), 400, { requestId });
    }
    bytes = new Uint8Array(await arquivo.arrayBuffer());
    tipo = farejarPrint(bytes);
    if (!tipo) return fail("validation_failed", t("O print precisa ser uma imagem WebP ou PNG."), 400, { requestId });
    caminho = caminhoDoPrint(orgId, relatoId, tipo);
  }

  const admin = createAdminClient();
  if (caminho && bytes && tipo) {
    const { error } = await admin.storage
      .from(BUCKET_DOS_RELATOS)
      .upload(caminho, bytes, { contentType: tipo, upsert: false });
    if (error) {
      logger.error("[bug-reports] upload do print falhou", { detalhe: error.message, requestId });
      return fail("internal_error", t("Não foi possível enviar o relato. Tente de novo."), 500, { requestId });
    }
  }

  const supabase = await createClient();
  const { error: erroInsert } = await supabase.from("bug_reports").insert({
    id: relatoId,
    organization_id: orgId,
    user_id: userId,
    description: descricao.data,
    page_url: contexto.data.url ?? null,
    context: contexto.data,
    screenshot_path: caminho,
  });
  if (erroInsert) {
    logger.error("[bug-reports] gravação do relato falhou", { detalhe: erroInsert.message, requestId });
    if (caminho) await admin.storage.from(BUCKET_DOS_RELATOS).remove([caminho]).catch(() => undefined);
    return fail("internal_error", t("Não foi possível enviar o relato. Tente de novo."), 500, { requestId });
  }

  await audit({
    organizationId: orgId,
    actorUserId: userId,
    action: "bug_report.created",
    resourceType: "bug_reports",
    resourceId: relatoId,
    requestId,
    metadata: { page_url: contexto.data.url ?? null, tem_print: caminho !== null },
  });

  return ok({ id: relatoId }, { requestId, status: 201 });
}
