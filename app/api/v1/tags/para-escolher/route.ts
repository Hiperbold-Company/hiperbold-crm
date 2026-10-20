/**
 * GET /api/v1/tags/para-escolher — as etiquetas da organização ativa para o editor
 * de tags do contato no Inbox: `{ tag, cor, grupo }`, na ordem cadastrada.
 *
 * ── Por que uma rota própria ─────────────────────────────────────────────────
 *
 * `GET /api/v1/tags/vocabulario` traz as mesmas etiquetas, mas exige `manager` e
 * MFA (a escrita reescreve o vocabulário de todos) — e o editor do Inbox é de quem
 * ATENDE (`agent`, `viewer`). `GET /api/v1/contact-tags` alcança quem atende, mas
 * só devolve nomes em uso, sem cor e sem grupo, e é a fonte do filtro do Inbox.
 * Esta rota é a leitura do vocabulário com o portão de `viewer` que as cores já
 * têm: ler a lista não é mexer nela.
 *
 * ── Fonte ────────────────────────────────────────────────────────────────────
 *
 * A mesma da tela de Tags: `settings.tags` (ordem, cor, grupo) e
 * `fn_vocabulario_de_tags` (o que está em uso e a semente), `security invoker` com
 * o client da SESSÃO — a RLS isola a organização, que vem de `requireRole`, nunca
 * do pedido. Sem MFA: é leitura de atalho, não ato (mesma razão de `/tags/cores`).
 *
 * A falha SOBE (500): lista vazia diria "esta organização não tem etiquetas" em
 * cima de um erro.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { opcoesDeEtiqueta, type LinhaParaEscolher } from "@/lib/tags/etiquetas-para-escolher";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "settings_tags" });
  if (!auth.ok) return auth.response;

  const db = await createClient();
  const [org, vocabulario] = await Promise.all([
    db.from("organizations").select("settings").eq("id", auth.org.orgId).maybeSingle(),
    db.rpc("fn_vocabulario_de_tags", { p_org: auth.org.orgId }),
  ]);
  const erro = org.error ?? vocabulario.error;
  if (erro) {
    logger.error("tags/para-escolher: leitura do vocabulário falhou", {
      requestId,
      orgId: auth.org.orgId,
      cause: erro.message,
    });
    return fail("internal_error", "Não foi possível carregar as etiquetas.", 500, { requestId });
  }

  const tags = opcoesDeEtiqueta(
    org.data?.settings ?? null,
    (vocabulario.data ?? []) as LinhaParaEscolher[],
  );
  return ok(tags, { requestId, meta: { total: tags.length } });
}
