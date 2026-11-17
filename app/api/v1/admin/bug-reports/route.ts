/**
 * GET /api/v1/admin/bug-reports — os relatos de problema de todas as organizações (migration 1018).
 *
 * Só administrador da instalação. Filtro por `status` (padrão `novo`); paginação por cursor
 * (created_at desc, id). A empresa vem do join com `organizations`; o e-mail de quem relatou, do
 * Auth, pelo service role.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { STATUS_DO_RELATO } from "@/lib/relatos/regras";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(STATUS_DO_RELATO).default("novo"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const cursorSchema = z.object({ created_at: z.string().min(1).max(64), id: z.string().uuid() });

function lerCursor(cursor: string): z.infer<typeof cursorSchema> | null {
  try {
    const r = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")));
    return r.success && !Number.isNaN(Date.parse(r.data.created_at)) ? r.data : null;
  } catch {
    return null;
  }
}

type OrgDoJoin = { display_name: string | null } | { display_name: string | null }[] | null;

interface LinhaDoRelato {
  id: string;
  organization_id: string;
  user_id: string | null;
  description: string;
  page_url: string | null;
  screenshot_path: string | null;
  status: string;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  organizations: OrgDoJoin;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return fail("validation_error", "Invalid query params", 400, { requestId });
  const { status, cursor, limit } = parsed.data;
  const posicao = cursor ? lerCursor(cursor) : null;
  if (cursor && !posicao) return fail("validation_error", "Invalid cursor", 400, { requestId });

  const admin = createAdminClient();
  let query = admin
    .from("bug_reports")
    .select(
      "id, organization_id, user_id, description, page_url, screenshot_path, status, admin_note, created_at, updated_at, organizations!bug_reports_organization_id_fkey(display_name)",
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (posicao) {
    query = query.or(
      `created_at.lt.${posicao.created_at},and(created_at.eq.${posicao.created_at},id.lt.${posicao.id})`,
    );
  }
  const { data, error } = await query;
  if (error) return fail("internal_error", "Failed to fetch bug reports", 500, { requestId });

  const linhas = (data ?? []) as unknown as LinhaDoRelato[];
  const has_more = linhas.length > limit;
  const pagina = has_more ? linhas.slice(0, limit) : linhas;
  const ultimo = pagina[pagina.length - 1];
  const proximo =
    has_more && ultimo
      ? Buffer.from(JSON.stringify({ created_at: ultimo.created_at, id: ultimo.id })).toString("base64url")
      : null;

  const ids = [...new Set(pagina.map((l) => l.user_id).filter((v): v is string => !!v))];
  const emails = new Map<string, string | null>();
  await Promise.all(
    ids.map(async (uid) => {
      const { data: u } = await admin.auth.admin.getUserById(uid);
      emails.set(uid, u?.user?.email ?? null);
    }),
  );

  const corpo = pagina.map(({ organizations, ...l }) => {
    const org = Array.isArray(organizations) ? organizations[0] : organizations;
    return {
      ...l,
      tem_print: l.screenshot_path !== null,
      empresa: org?.display_name ?? null,
      usuario_email: l.user_id ? (emails.get(l.user_id) ?? null) : null,
    };
  });

  return ok(corpo, { requestId, meta: { has_more, cursor: proximo } });
}
