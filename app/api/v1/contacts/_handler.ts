/**
 * Core handlers para /api/v1/contacts (lista + get + create + patch + delete).
 *
 * Reusados pelo Route Handler REST e por MCP tools (S-13.03/04).
 * - Recebem actor polimórfico (`user` | `ai_agent`).
 * - Lançam `ApiError` em caso de erro estruturado; sucesso retorna data.
 * - Audit + emit_event são responsabilidade do handler (DRY entre REST e MCP).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { observeServiceOrigin } from "@/lib/atendimento/origem";
import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { roleAtLeast } from "@/lib/auth/types";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { mesclarConsentimento } from "@/lib/contacts/consentimento";
import { hashCpf } from "@/lib/contacts/cpf";
import {
  CPF_SEM_LINHA,
  cifrarCpfDoContato,
  decifrarCpfDoContato,
  gravarCpfDoContatoPorUsuario,
  idsComCpf,
  idsPorHashDeCpf,
  type ErroDeCpf,
} from "@/lib/contacts/cpf-do-contato";
import { consultaDeContatos, semJuncoes } from "@/lib/contacts/consulta";
import {
  FILTRO_TEM_UTM,
  UTM_LINHAS_POR_PAGINA,
  SELECT_DE_UTM,
  utmsMaisRecentesPorContato,
  type NegocioComUtm,
} from "@/lib/contacts/utm-dos-negocios";
import { VINCULOS_RESTRICT_NAO_APAGADOS } from "@/lib/contacts/vinculos-restrict";
import { logger } from "@/lib/logger";
import type { Contact } from "@/lib/types/contacts";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import type {
  ContactCreate,
  ContactPatchInterno,
  ContactListQuery,
  ContactListQueryParams,
} from "@/lib/schemas";
import { contactListQuerySchema } from "@/lib/schemas";

type SB = SupabaseClient;

// `cpf_hash` e `cpf_encrypted` NÃO entram aqui: o papel `authenticated` não lê nem grava essas colunas (migration
// 0967, D-216), e pedir qualquer uma — ou `select *` — com a sessão do usuário dá "permission denied". Quem precisa de
// "tem CPF?" usa `idsComCpf` (lib/contacts/cpf-do-contato.ts), com o cliente de serviço.
const SELECT_COLS =
  "id, organization_id, name, display_name, email, email_normalized, phone_number, birthdate, is_blocked, blocked_reason, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, custom_fields, created_at, updated_at, last_activity_at, first_service_at";

interface CursorPayload {
  sort: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload & {
      last_activity_at?: string | null;
      created_at?: string | null;
    };
    if (typeof parsed.id !== "string") return null;
    // Cursores legados (só created_at) ou do formato anterior (last_activity_at).
    const sort = parsed.sort ?? parsed.last_activity_at ?? parsed.created_at ?? null;
    return { sort, id: parsed.id };
  } catch {
    return null;
  }
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * O contato como a API o devolve: SEM `cpf_hash`. O hash é só chave de busca interna (HMAC com segredo do
 * servidor); mesmo assim não sai em resposta nenhuma, e o cliente fica com o booleano `cpf_available`.
 */
export type ContatoPublico = Omit<Contact, "cpf_hash"> & { cpf_available: boolean };

export function semHashDeCpf<T extends { cpf_hash?: string | null; cpf_available?: boolean }>(
  c: T,
): Omit<T, "cpf_hash"> & { cpf_available: boolean } {
  const { cpf_hash, ...resto } = c;
  // `cpf_available` já calculado pelo servidor (a consulta do usuário não traz o hash) vale mais que o hash.
  return { ...resto, cpf_available: c.cpf_available ?? !!cpf_hash };
}

/**
 * CPF que já é de OUTRO contato da organização: recusa ANTES de gravar qualquer coisa, para create e patch
 * continuarem tudo-ou-nada como eram quando o CPF ia no mesmo INSERT/UPDATE (o índice único barrava o conjunto).
 * A corrida entre esta conferência e a gravação ainda cai no índice único, e o chamador desfaz.
 */
async function recusarCpfDeOutroContato(
  organizationId: string,
  hash: string,
  exceto: string | null,
  requestId: string,
): Promise<void> {
  const donos = await idsPorHashDeCpf(organizationId, hash);
  if (donos.error) throw new ApiError(500, "internal_error", undefined, requestId, donos.error.message);
  if (donos.ids.some((id) => id !== exceto)) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      requestId,
      'duplicate key value violates unique constraint "uniq_contacts_org_cpf"',
    );
  }
}

/** A gravação do CPF não alterou linha (contato anonimizado ou sumido): 409; qualquer outra falha, o 500 de sempre. */
function erroDaGravacaoDoCpf(erro: ErroDeCpf, requestId: string, idioma: Idioma): ApiError {
  if (erro.code === CPF_SEM_LINHA) {
    return new ApiError(
      409,
      "state_conflict",
      undefined,
      requestId,
      traduzir("Não foi possível gravar o CPF: o contato foi anonimizado ou não existe mais.", idioma),
    );
  }
  return new ApiError(500, "internal_error", undefined, requestId, erro.message);
}

/** Marca em cada contato se ele tem CPF, sem trazer o hash para a resposta nem para a memória. */
async function comCpfDisponivel(
  organizationId: string,
  contatos: Contact[],
  requestId: string,
): Promise<Contact[]> {
  const { ids, error } = await idsComCpf(
    organizationId,
    contatos.map((c) => c.id),
  );
  if (error) throw new ApiError(500, "internal_error", undefined, requestId, error.message);
  return contatos.map((c) => ({ ...c, cpf_available: ids.has(c.id) }));
}

export interface ListContactsResult {
  contacts: ContatoPublico[];
  cursor: string | null;
  has_more: boolean;
}

export async function listContactsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  raw: ContactListQueryParams,
  /** `timezone`: fuso da organização, para contar o dia dos filtros de data. */
  opcoes?: { timezone?: string | null },
): Promise<ListContactsResult> {
  const q: ContactListQuery = contactListQuerySchema.parse(raw);
  const sortCol = q.order_by;
  const asc = q.order_dir === "asc";

  const { query: consulta } = await consultaDeContatos(supabase, SELECT_COLS, q, {
    organizationId: ctx.organization_id,
    requestId: ctx.requestId,
    timezone: opcoes?.timezone,
  });
  let query = consulta
    .order(sortCol, { ascending: asc, nullsFirst: false })
    .order("id", { ascending: asc })
    .limit(q.limit + 1);

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      throw new ApiError(
        400,
        "invalid_cursor",
        undefined,
        ctx.requestId,
        traduzir("Cursor inválido.", ctx.idioma ?? "pt-BR"),
      );
    }
    const op = asc ? "gt" : "lt";
    if (c.sort) {
      query = query.or(
        `${sortCol}.${op}.${c.sort},and(${sortCol}.eq.${c.sort},id.${op}.${c.id})`,
      );
    } else {
      // Página na região de sort NULL (nulls last): pagina só por id.
      query = query.is(sortCol, null);
      query = asc ? query.gt("id", c.id) : query.lt("id", c.id);
    }
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = ((data ?? []) as unknown as Contact[]).map(semJuncoes);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sort: (last[sortCol] as string | null) ?? null,
          id: last.id,
        })
      : null;

  const { contacts, error: convErr } = await withConversas(
    supabase,
    ctx.organization_id,
    await comCpfDisponivel(ctx.organization_id, page, ctx.requestId),
  );
  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr);
  }

  let saida = contacts;
  if (q.com_utm) {
    const comUtm = await withUtms(supabase, ctx.organization_id, contacts);
    if (comUtm.error) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, comUtm.error);
    }
    saida = comUtm.contacts;
  }

  return { contacts: saida.map(semHashDeCpf) as ContatoPublico[], cursor: nextCursor, has_more: hasMore };
}

/**
 * Anexa os UTMs de cada contato da página, calculados dos NEGÓCIOS dele (o UTM mora em
 * `crm_leads.custom_fields`, nunca no contato). UMA consulta para a página inteira, filtrada pela
 * organização da sessão/token e pelos ids da página; só o JSON extraído das 5 chaves volta. Com a
 * sessão, a RLS de `crm_leads` ainda limita aos negócios que o usuário enxerga.
 *
 * UTM é dado de NEGÓCIO: quem chama com client admin (bearer) aplica antes a regra D-148
 * (`exigirVisibilidadeDoToken`), como `route.ts` faz para `com_utm`. Este handler não a repete.
 */
export async function withUtms(
  supabase: SB,
  organizationId: string,
  contacts: Contact[],
): Promise<{ contacts: Contact[]; error: string | null }> {
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return { contacts, error: null };

  const { data, error } = await supabase
    .from("crm_leads")
    .select(SELECT_DE_UTM)
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds)
    .or(FILTRO_TEM_UTM)
    // Do mais recente para o mais antigo, com teto explícito: se a página tiver mais negócios com
    // UTM que o `max_rows` do PostgREST, o corte perde só os mais antigos, nunca o que a coluna mostra.
    .order("created_at", { ascending: false })
    .limit(UTM_LINHAS_POR_PAGINA);
  if (error) return { contacts, error: error.message };

  const porContato = utmsMaisRecentesPorContato((data ?? []) as unknown as NegocioComUtm[]);
  return {
    contacts: contacts.map((c) => ({ ...c, utms: porContato.get(c.id) ?? {} })),
    error: null,
  };
}

/**
 * Anexa a conversa mais recente de cada contato — o atalho da lista para o inbox.
 * Mesma regra do quadro Kanban (`pipelines/[id]/board/route.ts:withConversas`).
 */
async function withConversas(
  supabase: SB,
  organizationId: string,
  contacts: Contact[],
): Promise<{ contacts: Contact[]; error: string | null }> {
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return { contacts, error: null };

  const { data, error } = await supabase
    .from("conversations")
    .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return { contacts, error: error.message };

  const porContato = new Map<string, NonNullable<Contact["conversa"]>>();
  for (const row of (data ?? []) as Array<{
    id: string;
    contact_id: string;
    last_message_preview: string | null;
    last_message_at: string | null;
    unread_count_for_assignee: number | null;
  }>) {
    if (porContato.has(row.contact_id)) continue;
    porContato.set(row.contact_id, {
      id: row.id,
      preview: row.last_message_preview,
      last_message_at: row.last_message_at,
      unread: row.unread_count_for_assignee ?? 0,
    });
  }

  return {
    contacts: contacts.map((contact) => {
      const conversa = porContato.get(contact.id);
      return conversa ? { ...contact, conversa } : contact;
    }),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export interface GetContactInput {
  contactId: string;
  decryptPurpose?: string | null;
}

export interface GetContactResult extends Omit<Contact, "cpf_hash"> {
  cpf_available: boolean;
  cpf_decrypted: string | null;
  cpf_decrypt_denied?: boolean;
}

export async function getContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: GetContactInput,
): Promise<GetContactResult> {
  const { data, error } = await supabase
    .from("contacts")
    .select(SELECT_COLS)
    .eq("id", input.contactId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  const [contact] = await comCpfDisponivel(ctx.organization_id, [data as Contact], ctx.requestId);
  if (!contact) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId);
  }

  let cpfDecrypted: string | null = null;
  let cpfDecryptDenied = false;

  if (input.decryptPurpose && contact.cpf_available && ctx.actor.type === "user") {
    const { data: membership } = await supabase
      .from("user_organizations")
      .select("role")
      .eq("user_id", ctx.actor.id)
      .eq("organization_id", contact.organization_id)
      .is("revoked_at", null)
      .maybeSingle();

    const role = membership?.role as string | undefined;
    if (!roleAtLeast(role, "manager")) {
      cpfDecryptDenied = true;
    } else {
      // Decifra no servidor (`fn_decrypt_oauth`, só service_role). O papel mínimo (manager) já foi conferido acima e
      // o audit logo abaixo registra a abertura, com `success` dizendo se saiu CPF.
      cpfDecrypted = await decifrarCpfDoContato(contact.organization_id, input.contactId);
      if (cpfDecrypted === null) {
        logger.warn("[contacts.get] não consegui decifrar o CPF do contato", {
          organizationId: contact.organization_id,
          contactId: input.contactId,
        });
      }
      const a = actorAuditPayload(ctx.actor);
      await audit({
        action: "contact.updated",
        actorUserId: a.actorUserId,
        actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
        organizationId: contact.organization_id,
        resourceType: "contact",
        resourceId: contact.id,
        requestId: ctx.requestId,
        metadata: {
          ...a.metadataActor,
          decrypt_purpose: input.decryptPurpose,
          success: !!cpfDecrypted,
        },
      });
    }
  }

  const { contacts: enriched, error: convErr } = await withConversas(supabase, ctx.organization_id, [
    contact,
  ]);
  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr);
  }
  const contactWithConversa = enriched[0] ?? contact;

  return {
    ...semHashDeCpf(contactWithConversa),
    cpf_available: contact.cpf_available === true,
    cpf_decrypted: cpfDecrypted,
    cpf_decrypt_denied: cpfDecryptDenied || undefined,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateContactResult {
  contact: ContatoPublico;
  action: "created";
}

export async function createContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: ContactCreate,
): Promise<CreateContactResult> {
  const a = actorAuditPayload(ctx.actor);
  const insertRow: Record<string, unknown> = {
    organization_id: ctx.organization_id,
    created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    name: input.name ?? null,
    display_name: input.display_name ?? null,
    email: input.email ?? null,
    phone_number: input.phone_number ? canonicalPhoneBR(input.phone_number) : null,
    birthdate: input.birthdate ?? null,
    tags: input.tags ?? [],
    source: input.source,
    source_metadata: input.source_metadata ?? {},
    custom_fields: input.custom_fields ?? {},
    consent: input.consent ?? {},
  };

  // O CPF NÃO vai no INSERT do usuário (D-216: o papel `authenticated` não grava `cpf_hash`/`cpf_encrypted`). Ele
  // é gravado logo depois pelo servidor, sobre o contato que a RLS acabou de aceitar criar.
  let cpfParaGravar: { hash: string; cifrado: string } | null = null;
  if (input.cpf) {
    const hash = hashCpf(input.cpf);
    // Sem a chave do servidor não há como gravar o CPF com segurança: recusa, nunca grava em claro nem com hash fraco.
    if (!hash) throw new ApiError(503, "cpf_indisponivel", undefined, ctx.requestId);
    // `cpf_hash` e `cpf_encrypted` vão juntos (contacts_cpf_consistency): sem a chave de cifra do banco, recusa
    // antes de criar o contato.
    const cifrado = await cifrarCpfDoContato(input.cpf);
    if (!cifrado) throw new ApiError(503, "cpf_indisponivel", undefined, ctx.requestId);
    // Confere o CPF repetido ANTES de inserir: o caminho normal não cria para depois apagar.
    await recusarCpfDeOutroContato(ctx.organization_id, hash, null, ctx.requestId);
    cpfParaGravar = { hash, cifrado };
  }

  const { data: created, error: insErr } = await supabase
    .from("contacts")
    .insert(insertRow)
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    // 409 quando o telefone já é de um contato vivo desta organização: o índice
    // parcial `uniq_contacts_org_phone` (organization_id, phone_number) barra o
    // insert com 23505. E-mail e CPF também têm trava única na tabela, então o
    // 23505 sozinho não diz qual índice bateu: só vira `contact_exists` se a
    // releitura do telefone achar um contato vivo. A releitura repete o filtro
    // por `organization_id` — o id devolvido no `details` nunca vem do corpo da
    // requisição — e qualquer outro conflito continua no 500 de sempre.
    const telefoneDoInsert = insertRow.phone_number as string | null;
    if (insErr.code === "23505" && telefoneDoInsert) {
      const existente = await encontrarContatoPorTelefone(
        supabase,
        ctx.organization_id,
        telefoneDoInsert,
      );
      if (existente) {
        throw new ApiError(
          409,
          "contact_exists",
          { contact_id: existente.id },
          ctx.requestId,
          traduzir("Já existe um contato com este telefone.", ctx.idioma ?? "pt-BR"),
        );
      }
    }
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, insErr.message);
  }

  const contact = created as Contact;
  if (cpfParaGravar) {
    const erroDoCpf = await gravarCpfDoContatoPorUsuario(ctx.organization_id, contact.id, cpfParaGravar);
    if (erroDoCpf) {
      // REDE DE SEGURANÇA, não o caminho normal (o CPF repetido já foi recusado antes do INSERT): só chega aqui por
      // corrida ou falha do banco. O contato já existe, então desfaz à mão, pelo cliente do usuário (a RLS de DELETE
      // vale), para o resultado visível continuar o mesmo — erro e nenhum contato criado.
      const { error: eApagar } = await supabase
        .from("contacts")
        .delete()
        .eq("organization_id", ctx.organization_id)
        .eq("id", contact.id);
      if (eApagar) {
        logger.error("[contacts.create] não consegui desfazer o contato criado sem CPF", {
          organizationId: ctx.organization_id,
          contactId: contact.id,
          errorCode: eApagar.code,
        });
      }
      throw erroDaGravacaoDoCpf(erroDoCpf, ctx.requestId, ctx.idioma ?? "pt-BR");
    }
    contact.cpf_available = true;
  }
  if (contact.phone_number) {
    try {
      const sessionId = await sessaoProntaParaEnvio(supabase, ctx.organization_id);
      if (sessionId) {
        await ensureConversation(supabase, ctx.organization_id, contact.id, sessionId);
      }
    } catch {
      // conversa no create é best-effort; o contato já existe
    }
  }

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.created",
      p_entity_kind: "contact",
      p_entity_id: contact.id,
      p_payload: {
        source: contact.source,
        has_email: !!contact.email,
        has_phone: !!contact.phone_number,
        has_cpf: contact.cpf_available === true,
      },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.create] emit_event failed", error.message);
    });

  await audit({
    action: "contact.created",
    actorUserId: a.actorUserId,
    actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, source: contact.source },
  });

  return { contact: semHashDeCpf(contact) as ContatoPublico, action: "created" };
}

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

export async function patchContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
  input: ContactPatchInterno,
): Promise<ContatoPublico> {
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    // ⚠️ Os campos sensíveis entram aqui para existir o **`from`** da regra L-06
    // ("audit com who/what/which/when/**from/to**", exceção: "Nenhuma"). Antes
    // este select pedia só `id, organization_id, is_anonymized, tags`, e o audit
    // gravava apenas os NOMES dos campos alterados — quem quisesse saber qual
    // e-mail foi substituído não tinha onde olhar. `consent` vem junto porque o
    // patch dele passou a ser MERGE (ver abaixo), e merge precisa do estado
    // anterior.
    .select(
      "id, organization_id, is_anonymized, tags, email, phone_number, name, display_name, consent, custom_fields",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  if (existing.is_anonymized) {
    throw new ApiError(
      403,
      "lgpd_anonymization_irreversible",
      undefined,
      ctx.requestId,
      traduzir("Contato anonimizado — edição bloqueada (LGPD).", ctx.idioma ?? "pt-BR"),
    );
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.display_name !== undefined) patch.display_name = input.display_name;
  // `email_normalized` NÃO entra no patch — é `GENERATED ALWAYS AS
  // (lower(trim(email))) STORED` (baseline.sql:1349), e o Postgres RECUSA
  // qualquer atribuição a coluna gerada (SQLSTATE 428C9), abortando o UPDATE
  // inteiro. Efeito medido: salvar o email de um contato pela tela devolvia 500,
  // e junto morriam todos os outros campos do mesmo PATCH.
  //
  // O banco deriva a coluna sozinho — era só não escrever nela.
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone_number !== undefined) {
    patch.phone_number = input.phone_number ? canonicalPhoneBR(input.phone_number) : input.phone_number;
  }
  if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.source !== undefined) patch.source = input.source;
  if (input.source_metadata !== undefined) patch.source_metadata = input.source_metadata;
  // SUBSTITUIÇÃO, não merge — ao contrário de `consent`. O editor da tela manda
  // o objeto inteiro que ele renderizou a partir do schema do funil; um merge
  // aqui tornaria IMPOSSÍVEL apagar um campo pela tela, porque a chave removida
  // voltaria do estado anterior a cada gravação.
  if (input.custom_fields !== undefined) patch.custom_fields = input.custom_fields;
  if (input.consent !== undefined) {
    // MERGE por finalidade, nunca substituição.
    //
    // `contacts.consent` é um mapa de finalidades — a regra L-05 nomeia
    // `marketing`, `transactional` e `profiling`. Atribuir o objeto inteiro
    // (o que esta linha fazia) significa que gravar UMA finalidade APAGA as
    // outras duas: registrar o consentimento transacional de alguém apagaria em
    // silêncio o consentimento de marketing que essa pessoa tinha dado.
    //
    // Perda de consentimento não é bug barulhento — é a base legal de um envio
    // futuro sumindo sem ninguém ver.
    //
    // A recusa registrada (`declined_at`) sobrevive a qualquer entrada (D-151):
    // o schema do PATCH da API já não aceita `consent`, e este merge é a segunda
    // trava para quem chama o handler por código do servidor.
    patch.consent = mesclarConsentimento(
      (existing as { consent?: Record<string, unknown> }).consent ?? {},
      input.consent,
    );
  }
  // O CPF NÃO vai no UPDATE do usuário (D-216): o servidor o grava depois, sobre o contato que a RLS aceitou alterar.
  let cpfParaGravar: { hash: string; cifrado: string } | null = null;
  if (input.cpf !== undefined) {
    const hash = hashCpf(input.cpf);
    if (!hash) throw new ApiError(503, "cpf_indisponivel", undefined, ctx.requestId);
    const cifrado = await cifrarCpfDoContato(input.cpf);
    if (!cifrado) throw new ApiError(503, "cpf_indisponivel", undefined, ctx.requestId);
    cpfParaGravar = { hash, cifrado };
    // Recusa antes de tocar em qualquer campo (PATCH tudo-ou-nada).
    await recusarCpfDeOutroContato(ctx.organization_id, hash, contactId, ctx.requestId);
  }

  if (Object.keys(patch).length === 0 && !cpfParaGravar) {
    throw new ApiError(
      400,
      "invalid_request",
      undefined,
      ctx.requestId,
      traduzir("Nenhum campo para atualizar.", ctx.idioma ?? "pt-BR"),
    );
  }

  const tagServiceOrigin = input.tags !== undefined
    ? await observeServiceOrigin(createAdminClient(), ctx.organization_id, contactId)
    : null;
  patch.updated_at = new Date().toISOString();

  const { data: updated, error: updErr } = await supabase
    .from("contacts")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .select(SELECT_COLS)
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado após update.", ctx.idioma ?? "pt-BR"),
    );
  }

  const contact = updated as Contact;
  if (cpfParaGravar) {
    const erroDoCpf = await gravarCpfDoContatoPorUsuario(ctx.organization_id, contact.id, cpfParaGravar);
    if (erroDoCpf) throw erroDaGravacaoDoCpf(erroDoCpf, ctx.requestId, ctx.idioma ?? "pt-BR");
  }
  const [comCpf] = await comCpfDisponivel(ctx.organization_id, [contact], ctx.requestId);
  contact.cpf_available = comCpf?.cpf_available === true;
  const a = actorAuditPayload(ctx.actor);
  // O `fields` sempre nomeou as colunas gravadas, inclusive as do CPF (agora gravadas à parte).
  const fields = [
    ...Object.keys(patch).filter((k) => k !== "updated_at"),
    ...(cpfParaGravar ? ["cpf_hash", "cpf_encrypted"] : []),
  ];

  /**
   * O par ANTES/DEPOIS dos campos que a L-06 nomeia.
   *
   * Grafia `old_`/`new_` seguindo o precedente de `team.role_changed`
   * (app/api/v1/team/[user_id]/_shared.ts:93-94), que tem teste-guarda. O repo
   * tem mais de uma grafia para este conceito; escolher a que já é vigiada evita
   * criar a quinta.
   *
   * Só os campos SENSÍVEIS e só quando mudaram: o audit é lido por humano e
   * despejar o objeto inteiro afogaria o que importa. `consent` entra como
   * lista de finalidades tocadas, não como jsonb cru — o valor é um mapa e o
   * que se audita é qual finalidade mudou.
   */
  const antes = existing as Record<string, unknown>;
  const sensiveis: Record<string, unknown> = {};
  for (const campo of ["email", "phone_number", "name", "display_name"]) {
    if (patch[campo] !== undefined && patch[campo] !== antes[campo]) {
      sensiveis[`old_${campo}`] = antes[campo] ?? null;
      sensiveis[`new_${campo}`] = patch[campo] ?? null;
    }
  }
  if (input.consent !== undefined) {
    sensiveis.consent_scopes = Object.keys(input.consent);
  }

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.updated",
      p_entity_kind: "contact",
      p_entity_id: contact.id,
      p_payload: { fields },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.patch] emit_event failed", error.message);
    });

  if (input.tags !== undefined) {
    const prevTags: string[] = (existing as { tags?: string[] }).tags ?? [];
    const addedTags = input.tags.filter((t) => !prevTags.includes(t));
    if (addedTags.length) {
      await createAdminClient()
        .rpc("emit_event", {
          p_event_type: "contact.tag_added",
          p_entity_kind: "contact",
          p_entity_id: contact.id,
          p_payload: { added_tags: addedTags, tags: input.tags, service_origin: tagServiceOrigin },
          p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
          p_organization_id: contact.organization_id,
        })
        .then(({ error }) => {
          if (error) console.error("[contacts.patch] emit_event failed", error.message);
        });
    }
  }

  await audit({
    action: "contact.updated",
    actorUserId: a.actorUserId,
    actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, fields, ...sensiveis },
  });

  return semHashDeCpf(contact) as ContatoPublico;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

function throwOnDbError(
  err: { code?: string; message: string } | null,
  requestId: string,
  idioma: Idioma = "pt-BR",
): void {
  if (!err) return;
  // conversations/messages apontam para contacts com ON DELETE RESTRICT.
  if (err.code === "23503") {
    throw new ApiError(
      409,
      "state_conflict",
      undefined,
      requestId,
      traduzir("Não foi possível excluir: o contato ainda tem registros vinculados.", idioma),
    );
  }
  throw new ApiError(500, "internal_error", undefined, requestId, err.message);
}

/**
 * Os vínculos `on delete restrict` que apontam para `contacts` e que este
 * handler NÃO apaga de propósito.
 *
 * Medido em `supabase/baseline.sql` (não inferido): além de
 * `conversations.contact_id` (linha 3531) e `messages.contact_id` (3781) — o
 * histórico, que sai logo abaixo porque é o pedido da exclusão —, a única FK
 * RESTRICT que sobra é `calendar_appointments.contact_id` (linha 15226, da
 * migração 0177). Ela é da agenda, e a decisão da 0177 foi explícita: o
 * compromisso aconteceu, tem dono e tem texto livre, então ele não cai por
 * cascata junto com a ficha.
 *
 * Conferir esta lista ANTES do primeiro DELETE é o arranjo que a issue #752
 * pede: sem ele, apagar `messages`/`conversations` e só então esbarrar no
 * RESTRICT é destruir o histórico do lead para devolver 409 — o pior dos dois
 * desfechos, porque a ficha continua lá e as mensagens não.
 *
 * Tabela nova com RESTRICT para `contacts` entra aqui como uma linha, e o
 * teste que acompanha este handler (`tests/unit/contato-delete.test.ts`)
 * exercita a contagem com filtro de organização.
 */

export async function deleteContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<{ id: string }> {
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id")
    .eq("id", contactId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  const a = actorAuditPayload(ctx.actor);

  // Pré-checagem dos vínculos que barram o DELETE da ficha (issue #752).
  //
  // Só CONTA: quem recusa continua sendo o banco, com o 23503 do RESTRICT. A
  // contagem existe para saber disso antes de apagar o histórico, e é por isso
  // que ela vem antes do primeiro DELETE — depois não há mais como desfazer.
  const vinculos: string[] = [];
  for (const vinculo of VINCULOS_RESTRICT_NAO_APAGADOS) {
    const { count, error } = await supabase
      .from(vinculo.tabela)
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("organization_id", ctx.organization_id);
    if (error) {
      // Falha da CONTAGEM não autoriza seguir apagando: seguir aqui é cair no
      // defeito que esta pré-checagem existe para impedir (histórico
      // destruído antes de saber se a ficha sai). Um 500 agora é reversível;
      // mensagem apagada não volta.
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
    }
    if ((count ?? 0) > 0) vinculos.push(`${count} ${vinculo.rotulo}`);
  }

  if (vinculos.length > 0) {
    // O 409 é o MESMO do caminho de FK (mesma causa, mesmo tratamento no
    // cliente), mas aqui ele chega com `messages`/`conversations` intactos.
    // O detalhe que o cliente não vê está na auditoria: `vinculos` diz o que
    // barrou, `apagados` vazio diz que nada foi tocado.
    await audit({
      action: "contact.delete_blocked",
      actorUserId: a.actorUserId,
      actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
      organizationId: ctx.organization_id,
      resourceType: "contact",
      resourceId: contactId,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, motivo: "vinculo_restrict", vinculos, apagados: [] },
    });
    throw new ApiError(
      409,
      "state_conflict",
      undefined,
      ctx.requestId,
      traduzir("Não foi possível excluir: o contato ainda tem registros vinculados.", ctx.idioma ?? "pt-BR"),
    );
  }

  // `apagados` é preenchido passo a passo de propósito: se um DELETE do meio
  // falhar, a linha de auditoria do erro precisa dizer exatamente até onde o
  // histórico foi, senão o incidente vira arqueologia.
  const apagados: string[] = [];
  let deleted: { id: string } | null = null;
  try {
    // Mensagens e conversas RESTRICT no contato: apagar primeiro, senão o
    // DELETE da ficha falha para qualquer lead que já falou no canal.
    const { error: msgErr } = await supabase
      .from("messages")
      .delete()
      .eq("contact_id", contactId)
      .eq("organization_id", ctx.organization_id);
    throwOnDbError(msgErr, ctx.requestId, ctx.idioma);
    apagados.push("messages");

    const { error: convErr } = await supabase
      .from("conversations")
      .delete()
      .eq("contact_id", contactId)
      .eq("organization_id", ctx.organization_id);
    throwOnDbError(convErr, ctx.requestId, ctx.idioma);
    apagados.push("conversations");

    const { data, error: delErr } = await supabase
      .from("contacts")
      .delete()
      .eq("id", contactId)
      .eq("organization_id", ctx.organization_id)
      .select("id")
      .maybeSingle();
    throwOnDbError(delErr, ctx.requestId, ctx.idioma);
    deleted = data;
  } catch (err) {
    // `audit()` é best-effort por doutrina (engole a própria falha e reporta),
    // então registrar aqui não pode trocar o desfecho do erro real.
    await audit({
      action: "contact.delete_blocked",
      actorUserId: a.actorUserId,
      actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
      organizationId: ctx.organization_id,
      resourceType: "contact",
      resourceId: contactId,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, motivo: "falha_ao_apagar", vinculos: [], apagados },
    });
    throw err;
  }

  if (!deleted) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.deleted",
      p_entity_kind: "contact",
      p_entity_id: contactId,
      p_payload: {},
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: ctx.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.delete] emit_event failed", error.message);
    });

  await audit({
    action: "contact.deleted",
    actorUserId: a.actorUserId,
    actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
    organizationId: ctx.organization_id,
    resourceType: "contact",
    resourceId: contactId,
    requestId: ctx.requestId,
    metadata: a.metadataActor,
  });

  return { id: deleted.id as string };
}
