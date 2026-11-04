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
import { revogarAcessosDoContato } from "@/lib/mcp/servidor-externo/do-agente/revogacao";
import { logger } from "@/lib/logger";
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
import {
  INDICE_CPF,
  INDICE_EMAIL,
  encontrarContatoPorCpfHash,
  encontrarContatoPorEmail,
  nomeDoIndiceUnico,
} from "@/lib/contacts/conflito-unico";
import type { Contact } from "@/lib/types/contacts";
import { abrirConversaDoContatoNovo } from "@/lib/contacts/conversa-ao-criar";
import type {
  ContactCreate,
  ContactPatchInterno,
  ContactListQuery,
  ContactListQueryParams,
} from "@/lib/schemas";
import { contactListQuerySchema } from "@/lib/schemas";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import {
  camposQueMudaram,
  defsDoPadraoDaOrg,
  erroDePadrao,
  recusasDePadrao,
} from "@/lib/leads/padrao-do-campo";
import { testaComPrazo } from "@/lib/leads/padrao-do-campo-no-servidor";

type SB = SupabaseClient;

// `cpf_hash` e `cpf_encrypted` NÃO entram aqui: o papel `authenticated` não lê nem grava essas colunas (migration
// 0967, D-216), e pedir qualquer uma — ou `select *` — com a sessão do usuário dá "permission denied". Quem precisa de
// "tem CPF?" usa `idsComCpf` (lib/contacts/cpf-do-contato.ts), com o cliente de serviço.
const SELECT_COLS =
  "id, organization_id, name, display_name, address_book_name, zip_code, street, number, complement, district, city, state, email, email_normalized, phone_number, birthdate, is_blocked, blocked_reason, is_personal, contact_type, ai_opt_out, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, custom_fields, created_at, updated_at, last_activity_at, first_service_at";

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
  idioma: Idioma,
): Promise<void> {
  const donos = await idsPorHashDeCpf(organizationId, hash);
  if (donos.error) throw new ApiError(500, "internal_error", undefined, requestId, donos.error.message);
  const outro = donos.ids.find((id) => id !== exceto);
  if (outro) {
    // #3084 (upstream): CPF repetido é 409 `contact_exists` com o id de quem já o tem — nunca o 500 de antes.
    // O id vem da consulta filtrada pela organização da sessão, não do corpo.
    throw new ApiError(
      409,
      "contact_exists",
      { contact_id: outro },
      requestId,
      traduzir("Já existe um contato com este CPF.", idioma),
    );
  }
}

/** A gravação do CPF não alterou linha (contato anonimizado ou sumido) ou o índice único barrou na corrida: 409; qualquer outra falha, o 500 de sempre. */
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
  if (erro.code === "23505") {
    // Corrida: outro pedido gravou o mesmo CPF entre a conferência e a gravação; o índice único barrou. Mesma
    // resposta de `recusarCpfDeOutroContato` (409 `contact_exists`), sem o id — aqui não há quem apontar.
    return new ApiError(
      409,
      "contact_exists",
      undefined,
      requestId,
      traduzir("Já existe um contato com este CPF.", idioma),
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
  /**
   * Só este contato — o escopo do turno do agente (`crm_search_contacts`).
   * Fora do `raw` de propósito: não é parâmetro da rota HTTP, e vai no WHERE,
   * antes do limite.
   */
  soContato?: string,
  /** `timezone`: fuso da organização, para contar o dia dos filtros de data. */
  opcoes?: { timezone?: string | null },
): Promise<ListContactsResult> {
  const q: ContactListQuery = contactListQuerySchema.parse(raw);

  // ─── O PISO DA BUSCA (#1835) ───────────────────────────────────────────────
  //
  // `?search=a` montava `name.ilike.%a%` e devolvia a LISTA INTEIRA — e lista
  // inteira sob busca não é resposta, é ruído que PARECE resposta. É a MESMA
  // medição que criou `PISO_DA_BUSCA` no inbox, aqui pela porta que hoje não a
  // tinha (a de conversas recusa no schema Zod; a de contatos deixava passar).
  //
  // A régua é consultada DENTRO do handler, e não no schema, de propósito: a
  // tela de contatos manda o termo como foi digitado (`useContactList` não tem
  // guarda de piso), então um `422` acenderia `showApiError` a cada letra
  // digitada; e o MCP (`crm_search_contacts`) chama este handler direto e
  // receberia um `ZodError` no meio da ferramenta. O efeito pedido é o mesmo
  // dos dois lados: abaixo do piso a busca NÃO VAI AO BANCO, e quem digita vê
  // a lista vazia até completar os dois caracteres.
  //
  // O piso mede o MESMO termo que vai ao filtro: sem os parênteses (ver o
  // bloco do `.or()` abaixo). Medir o cru deixava `"()"` consultar `%%` e
  // `"(a"` consultar `%a%` — a lista inteira de volta pela porta do parêntese.
  const termoDeTexto = q.search ? q.search.replace(/[()]/g, " ") : undefined;
  if (termoDeTexto !== undefined && !buscaValeConsulta(termoDeTexto)) {
    return { contacts: [], cursor: null, has_more: false };
  }

  const sortCol = q.order_by;
  const asc = q.order_dir === "asc";

  // A busca (regex que ignora acento, nome da agenda, telefones extras), as etiquetas em E/OU,
  // pessoais, bloqueados, os filtros ampliados, o `kind = person` e a lápide de fusão moram em
  // `consultaDeContatos` (lib/contacts/consulta.ts): a MESMA régua da contagem, do lote e da
  // exportação. Pessoal fica fora por padrão; `?pessoais=true` lista SÓ pessoais (spec 21, etapa 13).
  const { query: consulta } = await consultaDeContatos(supabase, SELECT_COLS, q, {
    organizationId: ctx.organization_id,
    requestId: ctx.requestId,
    timezone: opcoes?.timezone,
    soContato,
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
// conflito de dado único (#3084)
// ---------------------------------------------------------------------------

/**
 * Traduz um 23505 do INSERT/UPDATE de `contacts` no 409 `contact_exists` certo —
 * ou devolve `null` para deixá-lo seguir no 500 de sempre.
 *
 * ─── O telefone continua decidindo pela RELEITURA, não pelo texto ──────────
 *
 * O 23505 sozinho nomeia UM índice; o estado (contato vivo com o mesmo telefone
 * na mesma organização) já implica a trava de telefone de qualquer jeito. Por
 * isso o caminho do telefone é o de antes — a releitura por `organization_id`
 * decide, sem olhar o nome do índice. Mudar isso seria trocar um desenho que já
 * estava certo.
 *
 * ─── CPF e e-mail precisam do NOME do índice ───────────────────────────────
 *
 * Aqui não há como inferir pelo estado: o erro diz qual índice bateu (o driver
 * escreve o nome na `message`). Só o índice conhecido vira 409, e só depois de a
 * releitura — sempre repetindo `organization_id` e `is_merged_into IS NULL` —
 * achar o contato vivo que já tem o dado. Sem o contato, ou com o índice
 * trocado, o 23505 continua no 500: não se inventa 409 sobre um conflito que
 * não se sabe qual é.
 *
 * O `contact_id` devolvido vem SEMPRE da releitura, nunca do corpo.
 */
async function erroDeConflitoUnico(
  supabase: SB,
  ctx: HandlerCtx,
  campos: { phone_number?: unknown; email?: unknown; cpf_hash?: unknown },
  erro: { code?: string; message?: string; details?: string | null; constraint?: string | null },
  excluirId?: string,
): Promise<ApiError | null> {
  if (erro.code !== "23505") return null;
  const idioma = ctx.idioma ?? "pt-BR";

  // 1) CPF e e-mail — só quando o erro NOMEIA o índice (#3084). Vem ANTES do
  //    telefone: o PATCH da tela reenvia o telefone do PRÓPRIO contato, e a
  //    releitura por telefone o acharia — 409 de telefone apontando para si mesmo.
  const indice = nomeDoIndiceUnico(erro);
  if (indice === INDICE_CPF) {
    const hash = typeof campos.cpf_hash === "string" ? campos.cpf_hash : null;
    if (hash) {
      const existente = await encontrarContatoPorCpfHash(supabase, ctx.organization_id, hash);
      if (existente) {
        return new ApiError(
          409,
          "contact_exists",
          { contact_id: existente.id },
          ctx.requestId,
          traduzir("Já existe um contato com este CPF.", idioma),
        );
      }
    }
  }
  if (indice === INDICE_EMAIL) {
    const email = typeof campos.email === "string" ? campos.email : null;
    if (email) {
      const existente = await encontrarContatoPorEmail(supabase, ctx.organization_id, email);
      if (existente) {
        return new ApiError(
          409,
          "contact_exists",
          { contact_id: existente.id },
          ctx.requestId,
          traduzir("Já existe um contato com este e-mail.", idioma),
        );
      }
    }
  }

  // 2) Telefone — o desenho de sempre (fatia S1 da #852): a releitura decide,
  //    salvo quando o erro já nomeou CPF ou e-mail. No PATCH, `excluirId` é o
  //    contato editado: achar a si mesmo pelo telefone não explica conflito
  //    nenhum, e o 23505 segue no 500.
  if (indice === INDICE_CPF || indice === INDICE_EMAIL) return null;
  const telefone = typeof campos.phone_number === "string" ? campos.phone_number : null;
  if (telefone) {
    const existente = await encontrarContatoPorTelefone(supabase, ctx.organization_id, telefone);
    if (existente && existente.id !== excluirId) {
      return new ApiError(
        409,
        "contact_exists",
        { contact_id: existente.id },
        ctx.requestId,
        traduzir("Já existe um contato com este telefone.", idioma),
      );
    }
  }

  return null;
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
  // ── O PADRÃO (#2730) — a MESMA régua do formulário, aqui no SERVIDOR ──────
  //
  // O form é a primeira porta, não a garantia: dá para POSTar direto na API.
  // As definições vêm de TODOS os funis da organização, porque o CONTATO não
  // tem funil próprio — a tela lê o padrão (`useDefaultPipeline`) e o servidor,
  // que não sabe qual é, pergunta a todos.
  //
  // Falha de leitura devolve lista vazia e a escrita segue: fail-open da casa
  // (`settingsDoFunil` faz igual). Cair a rota por um `settings` torto seria
  // trocar "grava torto" por "não grava nada" — e a régua só tem poder sobre
  // o que ela consegue LER.
  if (input.custom_fields && Object.keys(input.custom_fields).length > 0) {
    // Escopo `contato` (#2852): a ficha do contato só recebe os campos do
    // CONTATO, e são só esses que ela pode gravar. Sem o filtro, o padrão de um
    // campo do NEGÓCIO — que o diálogo nem conhece — recusava a criação.
    const defs = await defsDoPadraoDaOrg(supabase, ctx.organization_id, "contato");
    const recusas = recusasDePadrao(defs, input.custom_fields, testaComPrazo);
    if (recusas.length > 0) throw erroDePadrao(recusas, ctx.requestId, ctx.idioma);
  }

  const a = actorAuditPayload(ctx.actor);
  const insertRow: Record<string, unknown> = {
    organization_id: ctx.organization_id,
    created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    name: input.name ?? null,
    display_name: input.display_name ?? null,
    zip_code: input.zip_code ?? null,
    street: input.street ?? null,
    number: input.number ?? null,
    complement: input.complement ?? null,
    district: input.district ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    email: input.email ?? null,
    phone_number: input.phone_number ? canonicalPhoneBR(input.phone_number) : null,
    birthdate: input.birthdate ?? null,
    // Só quando INFORMADO: sem a chave, quem grava o default é o banco
    // ('cliente', migration 0763) — e é isso que o invariante de coluna prova
    // ("contato novo nasce cliente sem ninguém informar").
    ...(input.contact_type !== undefined ? { contact_type: input.contact_type } : {}),
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
    await recusarCpfDeOutroContato(ctx.organization_id, hash, null, ctx.requestId, ctx.idioma ?? "pt-BR");
    cpfParaGravar = { hash, cifrado };
  }

  const { data: created, error: insErr } = await supabase
    .from("contacts")
    .insert(insertRow)
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    // 409 quando o dado já pertence a um contato vivo desta organização (#3084).
    //
    // O índice parcial `uniq_contacts_org_phone` (organization_id, phone_number)
    // barra o telefone repetido com 23505; o CPF (`uniq_contacts_org_cpf`) e o
    // e-mail (`uniq_contacts_org_email`) têm a mesma trava. O telefone decide
    // pela RELEITURA (não pelo texto do erro); CPF e e-mail usam o nome do
    // índice que o driver nomeia. A releitura repete o filtro por
    // `organization_id` — o id devolvido no `details` nunca vem do corpo da
    // requisição — e qualquer outro conflito continua no 500 de sempre.
    const conflito = await erroDeConflitoUnico(supabase, ctx, insertRow, insErr);
    if (conflito) throw conflito;
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
  // ── A CONVERSA DO CONTATO NOVO (#3718) ────────────────────────────────────
  //
  // A regra — esta porta abre, a importação por CSV não — mora num lugar só:
  // `lib/contacts/conversa-ao-criar.ts`. Aqui só se diz QUAL porta está
  // criando. A chamada é best-effort e não lança: o contato já está gravado, e
  // uma sessão torta não pode derrubar o cadastro. O que ela NÃO faz mais é
  // falhar calada — o erro sai em `logger.warn` lá dentro, com org, contato e
  // porta.
  await abrirConversaDoContatoNovo(supabase, {
    porta: "manual",
    organizationId: ctx.organization_id,
    contactId: contact.id,
    phoneNumber: contact.phone_number,
    requestId: ctx.requestId,
  });

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

  // ── O PADRÃO (#2730) — DEPOIS do select, e só sobre o que MUDOU ──────────
  //
  // A MESMA régua da criação, com a MESMA leitura (todos os funis, escopo
  // `contato`: o contato não tem funil próprio), mas agora JULGANDO O DIFF.
  //
  // Antes isto rodava no começo e julgava o `custom_fields` INTEIRO, na
  // suposição de que "PATCH manda só o que mudou" — suposição falsa para este
  // mapa: o `EditContactDialog` grava o objeto completo (o PATCH SUBSTITUI),
  // e a edição pela lista de contatos manda o mapa que nem renderizou. Efeito
  // medido no #2814: a pessoa troca só o nome e recebe 422 por um campo
  // escondido (`mostrar_quando`) — ou por um campo de outro funil — que ela
  // nem tocou. O estado anterior está aqui do lado (`existing.custom_fields`),
  // então o que se julga é o valor que vai ser DIFERENTE do gravado.
  if (input.custom_fields && Object.keys(input.custom_fields).length > 0) {
    const alterados = camposQueMudaram(
      input.custom_fields,
      (existing as { custom_fields?: unknown }).custom_fields,
    );
    if (Object.keys(alterados).length > 0) {
      const defs = await defsDoPadraoDaOrg(supabase, ctx.organization_id, "contato");
      const recusas = recusasDePadrao(defs, alterados, testaComPrazo);
      if (recusas.length > 0) throw erroDePadrao(recusas, ctx.requestId, ctx.idioma);
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.display_name !== undefined) patch.display_name = input.display_name;
  if (input.zip_code !== undefined) patch.zip_code = input.zip_code;
  if (input.street !== undefined) patch.street = input.street;
  if (input.number !== undefined) patch.number = input.number;
  if (input.complement !== undefined) patch.complement = input.complement;
  if (input.district !== undefined) patch.district = input.district;
  if (input.city !== undefined) patch.city = input.city;
  if (input.state !== undefined) patch.state = input.state;
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
  // O TIPO DO CONTATO (issue 3005): o PATCH troca cliente ↔ fornecedor. Ausente
  // NÃO entra no patch — quem não fala de tipo não reescreve a coluna, e é por
  // isso que o schema não tem default aqui (o default 'cliente' é do BANCO).
  if (input.contact_type !== undefined) patch.contact_type = input.contact_type;
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
    await recusarCpfDeOutroContato(ctx.organization_id, hash, contactId, ctx.requestId, ctx.idioma ?? "pt-BR");
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
    // #3084: o PATCH grava pela MESMA tabela e cai nas MESMAS travas únicas —
    // `uniq_contacts_org_email` é o caso medido na issue (trocar o e-mail por um
    // que já é de outro contato). O 409 sai com o `contact_id` de quem já tem o
    // dado; qualquer outro conflito segue no 500 de sempre.
    const conflito = await erroDeConflitoUnico(supabase, ctx, patch, updErr, contactId);
    if (conflito) throw conflito;
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

  /**
   * #2812 (segunda metade) — O CONTATO GANHOU TELEFONE.
   *
   * O gatilho `contact.phone_added` é a transição que faltava no vocabulário de
   * automação: a ficha que estava SEM número passa a ter um. Emitido AQUI, e só
   * aqui, por dois motivos que são a metade do trabalho:
   *
   *  - DEPOIS do UPDATE acima — a regra que este evento dispara lê a ficha para
   *    decidir, e a guarda `checarGuardasDeContato` (lib/automation/guarda-do-contato.ts)
   *    mata com `no_phone` (sem nova tentativa) quem chega sem número. Emitir
   *    antes da gravação entregaria à regra um contato ainda vazio, e o defeito
   *    é MUDO: a regra some sem erro, sem log e sem run.
   *  - SÓ na TRANSIÇÃO (antes vazio/nulo, depois preenchido) — quem já tinha
   *    número não "ganhou" nenhum, e tirar o número não é ganhá-lo. Um evento a
   *    cada edição de ficha encheria a fila de automação com o que não aconteceu.
   *
   * A grafia do par é a MESMA de `contact.tag_added`, logo acima — e o `contact.phone_added`
   * está irmão dele no mapa de gatilhos (lib/schemas/webhooks.ts).
   */
  const telefoneAntes = ((antes as { phone_number?: string | null }).phone_number ?? "").trim();
  const telefoneDepois = ((contact as { phone_number?: string | null }).phone_number ?? "").trim();
  if (!telefoneAntes && telefoneDepois) {
    await createAdminClient()
      .rpc("emit_event", {
        p_event_type: "contact.phone_added",
        p_entity_kind: "contact",
        p_entity_id: contact.id,
        p_payload: { phone_number: telefoneDepois },
        p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
        p_organization_id: contact.organization_id,
      })
      .then(({ error }) => {
        if (error) console.error("[contacts.patch] emit_event failed", error.message);
      });
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

/**
 * A ficha precisa existir DENTRO da organização de quem chama — o mesmo 404 da
 * exclusão. É a porta também da pré-checagem de vínculos (#1925): sem o filtro
 * por organização, um id alheio responderia "sem vínculos" e a tela diria que é
 * seguro excluir algo que quem chamou nem enxerga.
 */
async function contatoExistente(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<void> {
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
}

/**
 * Pré-checagem dos vínculos que barram o DELETE da ficha (issue #752), que a
 * pré-checagem da tela e a exclusão compartilham (#1925).
 *
 * Só CONTA: quem recusa continua sendo o banco, com o 23503 do RESTRICT. A
 * contagem existe para saber disso antes de apagar o histórico, e é por isso
 * que ela vem antes da chamada que apaga — depois não há mais como desfazer.
 */
async function contarVinculosRestrict(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<{ vinculos: string[]; por_tabela: Record<string, number> }> {
  const vinculos: string[] = [];
  // A contagem crua por tabela é o que a tela traduz e pluraliza; `vinculos`
  // (texto em pt-BR) segue igual ao da auditoria.
  const por_tabela: Record<string, number> = {};
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
    if ((count ?? 0) > 0) {
      vinculos.push(`${count} ${vinculo.rotulo}`);
      por_tabela[vinculo.tabela] = count ?? 0;
    }
  }
  return { vinculos, por_tabela };
}

/**
 * O que a exclusão VAI encontrar, apurado sem apagar nada: a pré-checagem que o
 * diálogo "Excluir contato?" consulta antes do clique (issue #1925).
 *
 * Reusa as duas funções acima de propósito: uma lista própria de vínculos para a
 * tela viraria uma segunda verdade — dia em que uma FK RESTRICT nova entrar em
 * `VINCULOS_RESTRICT_NAO_APAGADOS`, o diálogo avisaria de um bloqueio que não
 * existe e ficaria quieto sobre outro.
 */
export async function vinculosDoContatoHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<{ vinculos: string[]; por_tabela: Record<string, number> }> {
  await contatoExistente(supabase, ctx, contactId);
  return contarVinculosRestrict(supabase, ctx, contactId);
}

export async function deleteContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<{ id: string }> {
  await contatoExistente(supabase, ctx, contactId);

  const a = actorAuditPayload(ctx.actor);

  const { vinculos, por_tabela } = await contarVinculosRestrict(supabase, ctx, contactId);

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
      { vinculos, por_tabela },
      ctx.requestId,
      traduzir("Não foi possível excluir: o contato ainda tem registros vinculados.", ctx.idioma ?? "pt-BR"),
    );
  }

  // UMA função, UMA transação (issue #1862).
  //
  // Antes eram três DELETE separados: `messages`, depois `conversations`, depois
  // `contacts`. Quando a última chamada era recusada (o gatilho de follow-up
  // devolvia 42501 em quem tem `auth.uid()`), as duas primeiras já estavam
  // gravadas — a ficha ficava na base SEM histórico, e a auditoria do erro saía
  // com `apagados: ["messages","conversations"]` como rastro do estrago.
  //
  // Agora a rota chama `fn_apagar_contato_com_historico` (migration 0488), que
  // apaga as três na ordem certa do RESTRICT dentro de uma transação só: ou sai
  // tudo, ou não sai nada. É `security invoker` — a RLS de quem chama continua
  // valendo, e o filtro de `organization_id` é do banco (argumento + where), não
  // do chamador. Nenhum service role entra aqui.
  //
  // A exceção, antes da transação: os acessos OAuth do contato a servidores
  // MCP externos (9095). A cascata apaga o token, e sem ele não há revogação no
  // terceiro (RFC 7009) — então revoga primeiro. A tabela é server-side only
  // (service role), filtrada pela organização do ctx. Melhor esforço: falha
  // do terceiro não barra a exclusão.
  await revogarAcessosDoContato(createAdminClient(), ctx.organization_id, contactId).catch((err: unknown) => {
    logger.warn("revogacao dos acessos MCP do contato falhou antes da exclusao", {
      organization_id: ctx.organization_id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  let apagou = false;
  try {
    const { data, error: rpcErr } = await supabase.rpc("fn_apagar_contato_com_historico", {
      p_contact_id: contactId,
      p_organization_id: ctx.organization_id,
    });
    throwOnDbError(rpcErr, ctx.requestId, ctx.idioma);
    apagou = data === true;
  } catch (err) {
    // `audit()` é best-effort por doutrina (engole a própria falha e reporta),
    // então registrar aqui não pode trocar o desfecho do erro real.
    //
    // `apagados` fica VAZIO de propósito: numa transação só não existe "chegou
    // até a metade". Ou a ficha saiu com o histórico (aqui seria outro desfecho),
    // ou a transação desfez tudo — e é isso que a linha de auditoria diz.
    await audit({
      action: "contact.delete_blocked",
      actorUserId: a.actorUserId,
      actorApiTokenId: colunasDeAtorNoAudit(ctx.actor).actorApiTokenId,
      organizationId: ctx.organization_id,
      resourceType: "contact",
      resourceId: contactId,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, motivo: "falha_ao_apagar", vinculos: [], apagados: [] },
    });
    throw err;
  }

  if (!apagou) {
    // A ficha existia na pré-checagem e sumiu antes da chamada (outra sessão a
    // apagou, ou a RLS não a deixou ver): o mesmo 404 de sempre.
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

  return { id: contactId };
}
