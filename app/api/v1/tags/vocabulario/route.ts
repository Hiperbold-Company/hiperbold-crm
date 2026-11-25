/**
 * GET/POST /api/v1/tags/vocabulario — o vocabulário de etiquetas da organização
 * ativa, e as operações que faltavam nele (issue #852, fatia S4; cor: #1271, S6).
 *
 * ── Por que manager, e não agent ─────────────────────────────────────────────
 *
 * A leitura é inofensiva, mas a escrita REESCREVE o vocabulário de todo mundo da
 * organização, inclusive as regras `add_tag` dos agentes — é decisão de
 * configuração, não de atendimento. Mesmo gate do roteamento de filas
 * (`settings_routing`), que também é configuração de organização.
 *
 * `definir_cor` é configuração pelo mesmo motivo, ainda que não toque em linha
 * nenhuma: quem escolhe a cor de "reclamação" está dizendo como a organização
 * inteira lê a lista. A leitura leve das cores para o CHIP tem portão próprio
 * (`GET /api/v1/tags/cores`, `viewer`) — o que muda ali é a pergunta, não o
 * dado: "de que cor é esta etiqueta" não é "posso mexer nesta etiqueta".
 *
 * ── Por que a rota existe, se o Inbox já lê `GET /conversation-tags` ─────────
 *
 * São perguntas diferentes. `conversation-tags` responde "que etiqueta eu posso
 * oferecer neste atendimento" (vocabulário + o que está em uso). Esta responde
 * "onde esta etiqueta está, com que peso, e o que acontece se eu mexer nela" —
 * com uso por tabela e o número de regras de agente que ainda escrevem o nome.
 * A tela de Tags precisa das duas informações antes de deixar renomear: sem
 * elas, renomear é aposta.
 *
 * ── Contrato de leitura (combinado no fio da #852) ───────────────────────────
 *
 * `data` é uma lista, uma linha por etiqueta:
 * `{ tag, uso_em_contatos, uso_em_leads, uso_em_conversas, em_regras, cor,
 *    descricao, no_vocabulario }` — os mesmos nomes de campo que a leitura "em
 * uso" já usa, para a troca de fonte custar uma linha por campo.
 */
import { randomUUID } from "node:crypto";
import { tagsPageQuerySchema, tagsPageResultSchema } from "@/lib/schemas/tags";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { vocabularioDeTagsSchema, type LinhaDeVocabulario } from "@/lib/schemas/tags";
import { normalizarTag } from "@/lib/contacts/tag-normalizada";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Teto do vocabulário curado (`settings.tags`): acima disso a tela vira lista de arquivo morto. */
export const TETO_DO_VOCABULARIO = 200;

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  if (req.nextUrl.searchParams.has("page") || req.nextUrl.searchParams.has("busca")) {
    const parsed = tagsPageQuerySchema.safeParse({
      page: req.nextUrl.searchParams.get("page") ?? undefined,
      busca: req.nextUrl.searchParams.get("busca") ?? undefined,
    });
    if (!parsed.success) return fail("validation_failed", "Confira a busca e a página.", 422, { requestId });
    const db = await createClient();
    const { data, error } = await db.rpc("fn_vocabulario_de_tags_pagina", {
      p_org: auth.org.orgId, p_busca: parsed.data.busca,
      p_offset: (parsed.data.page - 1) * 100, p_limit: 100,
    });
    const page = tagsPageResultSchema.safeParse(data);
    if (error || !page.success) return fail("internal_error", "Não foi possível carregar as etiquetas.", 500, { requestId });
    return ok(page.data.items, { requestId, meta: { total: page.data.total, page: parsed.data.page, per_page: 100 } });
  }

  const db = await createClient();
  // Client da SESSÃO: a função é `security invoker`, então quem recorta a
  // organização é a RLS e o `p_org` da sessão — pedir a de outro tenant não
  // devolve nada.
  const { data, error } = await db.rpc("fn_vocabulario_de_tags", {
    p_org: auth.org.orgId,
  });
  if (error) return fail("internal_error", "Não foi possível carregar as etiquetas.", 500, { requestId });

  const tags = (data ?? []) as LinhaDeVocabulario[];
  return ok(tags, {
    requestId,
    meta: {
      total: tags.length,
      // Quantas etiquetas a TELA não pode renomear em silêncio: cada uma delas
      // é um agente que ainda vai escrever esse nome amanhã.
      em_regras: tags.filter((t) => t.em_regras > 0).length,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  // ⚠️ SEM `allowPlatformAdmin`. O portão de escrita é o da FUNÇÃO
  // (`fn_role_at_least(p_org, 'manager')`, que não conhece platform admin), e
  // deixar passar aqui só adiava o 42501 → 403 para depois do clique. A leitura
  // acima segue a mesma régua, para a tela não oferecer o que a escrita recusa.
  const auth = await requireRole("manager", { requestId, resource: "settings_tags" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = vocabularioDeTagsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira a etiqueta, o novo nome e a cor.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const { acao, tag, destino, cor } = parsed.data;

  const db = await createClient();

  if (acao === "criar") return criarEtiqueta({ db, auth, requestId, tag, cor });

  // #2855 — com a tela paginada, o destino da junção é digitado, não escolhido
  // numa lista. A função só recusa destino vazio: um nome que não existe faria
  // "juntar" virar um renomear sem aviso. A conferência é no vocabulário INTEIRO
  // (curado + em uso + regras), pela mesma leitura paginada da tela.
  // ponytail: lê só os 200 primeiros nomes que CONTÊM o destino; acima disso uma
  // etiqueta existente pode ser recusada (falha fechada, sem perda de dado).
  if (acao === "juntar" && destino) {
    const { data: achadas, error: erroDaBusca } = await db.rpc("fn_vocabulario_de_tags_pagina", {
      p_org: auth.org.orgId,
      p_busca: destino.trim(),
      p_offset: 0,
      p_limit: 200,
    });
    const pagina = tagsPageResultSchema.safeParse(achadas);
    if (erroDaBusca || !pagina.success)
      return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });
    const chave = destino.trim().toLowerCase();
    if (!pagina.data.items.some((linha) => linha.tag.trim().toLowerCase() === chave))
      return fail("destino_inexistente", "A etiqueta de destino não existe nesta organização.", 422, { requestId });
  }

  // Uma chamada só. Renomear a etiqueta e trocar o nome nas regras `add_tag` dos
  // agentes acontece na MESMA transação — é isto que impede o estado que a issue
  // descreve: contato renomeado com o agente ainda escrevendo o nome antigo.
  // `p_cor` vai sempre (nulo fora do `definir_cor`): a assinatura da função tem
  // o parâmetro com `default null`, e mandar o campo explícito evita depender de
  // como o PostgREST resolve chamadas com argumento faltando.
  const { data, error } = await db.rpc("fn_vocabulario_de_tags_operar", {
    p_org: auth.org.orgId,
    p_acao: acao,
    p_tag: tag,
    p_destino: destino ?? null,
    p_cor: cor ?? null,
  });
  if (error) {
    if (error.code === "42501")
      return fail("forbidden", "Esta sessão não pode mudar as etiquetas da organização.", 403, { requestId });
    if (error.code === "22023")
      return fail("validation_failed", "Confira a etiqueta, o novo nome e a cor.", 422, { requestId });
    return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });
  }

  const resultado = (data ?? {}) as Record<string, unknown>;
  void audit({
    action: "tag_vocabulary.changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    requestId,
    metadata: { acao, tag, destino: destino ?? null, cor: cor ?? null, ...resultado },
  });
  return ok(resultado, { requestId });
}

/**
 * `criar`: a etiqueta nasce no vocabulário curado (`organizations.settings.tags`)
 * antes de qualquer contato, negócio ou conversa usá-la. O acréscimo é atômico no
 * banco (`fn_acrescentar_etiqueta_ao_vocabulario`, migration 1023): trava a linha da
 * organização, recusa duplicata e teto e grava só a chave `tags`.
 */
async function criarEtiqueta(p: {
  db: Awaited<ReturnType<typeof createClient>>;
  auth: Extract<Awaited<ReturnType<typeof requireRole>>, { ok: true }>;
  requestId: string;
  tag: string;
  cor: string | null | undefined;
}): Promise<Response> {
  const { db, auth, requestId } = p;
  const nome = normalizarTag(p.tag);
  if (nome === "") return fail("validation_failed", "Dê um nome para a etiqueta.", 422, { requestId });
  const cor = p.cor ?? null;

  // O vocabulário INTEIRO (curado + em uso + regras), a mesma leitura da tela:
  // "já existe" é o que o operador vê na lista, não só o que está curado.
  const { data: achadas, error: erroDaBusca } = await db.rpc("fn_vocabulario_de_tags_pagina", {
    p_org: auth.org.orgId,
    p_busca: nome,
    p_offset: 0,
    p_limit: 200,
  });
  const pagina = tagsPageResultSchema.safeParse(achadas);
  if (erroDaBusca || !pagina.success)
    return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });
  if (pagina.data.items.some((linha) => normalizarTag(linha.tag) === nome))
    return fail("tag_ja_existe", "Essa etiqueta já existe.", 409, { requestId });

  // A checagem, o teto e o acréscimo são UM passo no banco, com a linha da organização travada:
  // dois "criar" simultâneos se enfileiram e o segundo parte da lista que o primeiro gravou.
  const { data: situacao, error: erroDoAcrescimo } = await createAdminClient().rpc(
    "fn_acrescentar_etiqueta_ao_vocabulario",
    { p_org: auth.org.orgId, p_nome: nome, p_cor: cor, p_teto: TETO_DO_VOCABULARIO },
  );
  if (erroDoAcrescimo) return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });
  if (situacao === "ja_existe") return fail("tag_ja_existe", "Essa etiqueta já existe.", 409, { requestId });
  if (situacao === "limite")
    return fail(
      "limite_de_etiquetas",
      `O vocabulário chegou ao limite de ${TETO_DO_VOCABULARIO} etiquetas. Exclua ou junte alguma antes de criar outra.`,
      422,
      { requestId },
    );
  if (situacao !== "criada") return fail("internal_error", "Não foi possível concluir a operação.", 500, { requestId });

  const resultado = { tag: nome, cor };
  void audit({
    action: "tag_vocabulary.changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    requestId,
    metadata: { acao: "criar", tag: nome, destino: null, cor },
  });
  return ok(resultado, { requestId, status: 201 });
}
