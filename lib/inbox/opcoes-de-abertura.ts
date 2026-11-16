/**
 * Lê do banco o que `decidirAbertura` e `envioPermitidoPelaConexao` precisam
 * (`lib/inbox/conexao-ao-abrir.ts`).
 *
 * Roda com o cliente ADMIN: o atendente não enxerga pela RLS os responsáveis de
 * todas as conexões nem as conversas do colega, e a decisão precisa saber que
 * elas existem. Por isso TODA leitura filtra `organization_id` pela org que o
 * chamador resolveu de fonte confiável (sessão), nunca do corpo.
 *
 * O que VOLTA para a tela respeita a visibilidade: com `sessao` (o cliente da
 * sessão do navegador, sob RLS), a lista `conversas` só traz as que a pessoa
 * enxerga — o mesmo predicado de `conversations_select` / `visibility_mode`.
 * Das outras a tela só fica sabendo que existem em conexão de outro atendente
 * (`contato_em_conexao_de_outro`), sem id nem nome.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { ehCanalSocial, transportaMensagem } from "@/lib/channels/capabilities";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";
import { modoDeConexaoAoAbrir, type ModoDeConexaoAoAbrir } from "@/lib/schemas/routing";
import {
  conversaAberta,
  envioPermitidoPelaConexao,
  nomeDaConexao,
  type ConexaoResumo,
  type ConversaDoContatoNaConexao,
  type OpcoesDeAbertura,
} from "@/lib/inbox/conexao-ao-abrir";

interface SessaoLida {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  provider: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

export interface EntradaDasOpcoes {
  organizationId: string;
  userId: string;
  role: Role | string | undefined;
  contactId?: string | null;
  /** Sem `contactId`, o contato é procurado por este telefone, na mesma org. */
  phone?: string | null;
  leadId?: string | null;
  /**
   * Cliente da SESSÃO (RLS). Presente = a lista `conversas` é recortada pelo
   * que a pessoa enxerga, quando ela está abaixo de gerente. Ausente (a guarda
   * do servidor) = todas, porque a regra precisa delas.
   */
  sessao?: SupabaseClient;
}

/** Conexão por onde se conversa 1:1 com um telefone: mensagem e não rede social. */
function servePara1a1(s: SessaoLida): boolean {
  return transportaMensagem(s.provider) && !ehCanalSocial(s.provider);
}

function conectada(s: SessaoLida): boolean {
  const pausada = s.metadata?.disabled === true || s.metadata?.disabled === "true";
  return s.status === "WORKING" && !pausada;
}

/** A conectada primeiro; empate pela mais antiga (a lista já vem ordenada). */
function preferida(lista: SessaoLida[]): ConexaoResumo | null {
  const s = lista.find(conectada) ?? lista[0];
  return s ? { id: s.id, nome: nomeDaConexao(s), conectada: conectada(s) } : null;
}

function falha(erro: { message: string } | null): void {
  if (erro) throw new Error(erro.message);
}

export async function resolverContatoPorTelefone(
  admin: SupabaseClient,
  organizationId: string,
  phone: string | null | undefined,
): Promise<string | null> {
  const telefone = phone ? parseDialablePhone(phone) : null;
  if (!telefone) return null;
  const achado = await encontrarContatoPorTelefone(admin as never, organizationId, canonicalPhoneBR(telefone));
  return achado?.id ?? null;
}

/**
 * O negócio passou a ser MEU por ato de OUTRA pessoa: sou o dono, e a última
 * troca de responsável registrada na linha do tempo (`lead_edited` com
 * `owner_user_id` nos campos) foi feita por outro usuário. Negócio que eu
 * criei ou me atribuí não conta.
 */
async function negocioPassadoParaMim(
  admin: SupabaseClient,
  e: EntradaDasOpcoes,
  contactId: string,
): Promise<boolean> {
  if (!e.leadId) return false;
  const { data: lead, error } = await admin
    .from("crm_leads")
    .select("owner_user_id")
    .eq("organization_id", e.organizationId)
    .eq("id", e.leadId)
    .eq("contact_id", contactId)
    .maybeSingle();
  falha(error);
  if ((lead as { owner_user_id?: string | null } | null)?.owner_user_id !== e.userId) return false;

  const { data: atividades, error: atErr } = await admin
    .from("crm_lead_activities")
    .select("payload, performed_by_user_id, performed_at")
    .eq("organization_id", e.organizationId)
    .eq("lead_id", e.leadId)
    .eq("type", "lead_edited")
    .order("performed_at", { ascending: false })
    .limit(50);
  falha(atErr);
  const troca = ((atividades ?? []) as Array<{
    payload: { fields?: unknown } | null;
    performed_by_user_id: string | null;
  }>).find((a) => Array.isArray(a.payload?.fields) && (a.payload.fields as unknown[]).includes("owner_user_id"));
  return !!troca?.performed_by_user_id && troca.performed_by_user_id !== e.userId;
}

export async function carregarOpcoesDeAbertura(
  admin: SupabaseClient,
  e: EntradaDasOpcoes,
): Promise<OpcoesDeAbertura> {
  const org = e.organizationId;

  const [orgRes, sessRes, polRes, respRes] = await Promise.all([
    admin.from("organizations").select("settings").eq("id", org).maybeSingle(),
    admin
      .from("channel_sessions")
      .select("id, display_name, phone_number, provider, status, metadata, created_at")
      .eq("organization_id", org)
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
    admin.from("channel_routing_policies").select("id, channel_session_id").eq("organization_id", org),
    admin.from("channel_routing_responsibles").select("policy_id, user_id").eq("organization_id", org),
  ]);
  falha(orgRes.error);
  falha(sessRes.error);
  falha(polRes.error);
  falha(respRes.error);

  const modo = modoDeConexaoAoAbrir((orgRes.data as { settings?: unknown } | null)?.settings);
  const rank = ROLE_RANK[(e.role ?? "viewer") as Role] ?? 0;
  const abaixoDeGerente = rank < ROLE_RANK.manager;
  const restrito = modo === "own_only" && abaixoDeGerente;

  const sessoes = ((sessRes.data ?? []) as SessaoLida[]).filter(servePara1a1);
  const politicas = (polRes.data ?? []) as Array<{ id: string; channel_session_id: string }>;
  const responsaveis = (respRes.data ?? []) as Array<{ policy_id: string; user_id: string }>;
  const responsaveisDa = (sessaoId: string): string[] => {
    const ids = politicas.filter((p) => p.channel_session_id === sessaoId).map((p) => p.id);
    return responsaveis.filter((r) => ids.includes(r.policy_id)).map((r) => r.user_id);
  };

  const minhas = sessoes.filter((s) => responsaveisDa(s.id).includes(e.userId));
  const comResponsavel = sessoes.filter((s) => responsaveisDa(s.id).length > 0);
  const gerais = sessoes.filter((s) => responsaveisDa(s.id).length === 0);
  const porId = new Map(sessoes.map((s) => [s.id, s]));

  let contactId = e.contactId ?? null;
  if (!contactId && e.phone) contactId = await resolverContatoPorTelefone(admin, org, e.phone);

  const conversas: ConversaDoContatoNaConexao[] = [];
  let emConexaoDeOutro = false;
  let transferido = false;

  if (contactId) {
    const { data: convs, error: convErr } = await admin
      .from("conversations")
      .select("id, channel_session_id, assigned_to_user_id, status, last_message_at")
      .eq("organization_id", org)
      .eq("contact_id", contactId)
      .eq("is_group", false)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    falha(convErr);
    const lidas = (convs ?? []) as Array<{
      id: string;
      channel_session_id: string | null;
      assigned_to_user_id: string | null;
      status: string | null;
    }>;

    let visiveis: Set<string> | null = null;
    if (e.sessao && abaixoDeGerente) {
      const { data: vis, error: visErr } = await e.sessao
        .from("conversations")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contactId)
        .eq("is_group", false);
      falha(visErr);
      visiveis = new Set(((vis ?? []) as Array<{ id: string }>).map((v) => v.id));
    }

    const vistas = new Set<string>();
    for (const c of lidas) {
      // Conexão arquivada, de rede social ou de outra org não entra (o mapa só
      // tem as sessões desta org, não arquivadas, de 1:1).
      const s = c.channel_session_id ? porId.get(c.channel_session_id) : undefined;
      if (!s) continue;
      const resp = responsaveisDa(s.id);
      const deOutro = resp.length > 0 && !resp.includes(e.userId);
      const abertaEMinha = conversaAberta(c.status) && c.assigned_to_user_id === e.userId;
      if (deOutro) emConexaoDeOutro = true;
      if (abertaEMinha) transferido = true;
      if (visiveis && !visiveis.has(c.id)) continue;
      if (vistas.has(s.id)) continue;
      vistas.add(s.id);
      conversas.push({
        conversation_id: c.id,
        channel_session_id: s.id,
        conexao_nome: nomeDaConexao(s),
        conexao_de_outro: deOutro,
        aberta_e_minha: abertaEMinha,
      });
    }

    if (!transferido) transferido = await negocioPassadoParaMim(admin, e, contactId);
  }

  return {
    modo,
    restrito,
    minha_conexao: preferida(minhas),
    minhas_conexoes_ids: minhas.map((s) => s.id),
    conexao_geral: preferida(gerais),
    conexoes_com_responsavel_ids: comResponsavel.map((s) => s.id),
    conversas: conversas.slice(0, 20),
    contato_em_conexao_de_outro: emConexaoDeOutro,
    transferido_para_mim: transferido,
  };
}

/**
 * A pergunta do ENVIO no modo restrito, já lida: quem envia é atendente, a
 * organização está em `own_only`, e esta sessão/conversa não é dele, nem do
 * número geral, nem uma conversa aberta atribuída a ele.
 */
/** O modo da organização ("deixar escolher" × "só a conexão própria"). Lança se a leitura falhar. */
export async function modoDaOrganizacao(
  db: SupabaseClient,
  organizationId: string,
): Promise<ModoDeConexaoAoAbrir> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  falha(error);
  return modoDeConexaoAoAbrir((data as { settings?: unknown } | null)?.settings);
}

export async function envioRecusadoPelaConexao(
  db: SupabaseClient,
  p: {
    /** O modo, quando quem chama já o leu (o envio lê antes da guarda do número). */
    modoJaLido?: ModoDeConexaoAoAbrir;
    organizationId: string;
    userId: string;
    role: string | undefined;
    conversationId: string;
    channelSessionId: string | null;
  },
): Promise<boolean> {
  const rank = ROLE_RANK[(p.role ?? "viewer") as Role] ?? 0;
  if (rank >= ROLE_RANK.manager) return false;
  if (!p.channelSessionId) return false;

  // A conexão primeiro: é a mesma leitura que a guarda do número (#3642) já
  // faz, e no caso comum (número sem responsável, ou meu) a resposta sai aqui,
  // sem ler mais nada.
  const { data: policy, error: polErr } = await db
    .from("channel_routing_policies")
    .select("id")
    .eq("organization_id", p.organizationId)
    .eq("channel_session_id", p.channelSessionId)
    .maybeSingle();
  falha(polErr);
  if (!policy) return false;
  const { data: rs, error: rErr } = await db
    .from("channel_routing_responsibles")
    .select("user_id")
    .eq("organization_id", p.organizationId)
    .eq("policy_id", (policy as { id: string }).id);
  falha(rErr);
  const resp = ((rs ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id));
  if (resp.length === 0 || resp.includes(p.userId)) return false; // atalho: não lê a conversa

  if ((p.modoJaLido ?? (await modoDaOrganizacao(db, p.organizationId))) !== "own_only") return false;

  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("status, assigned_to_user_id")
    .eq("organization_id", p.organizationId)
    .eq("id", p.conversationId)
    .maybeSingle();
  falha(convErr);
  const c = conv as { status?: string | null; assigned_to_user_id?: string | null } | null;
  return !envioPermitidoPelaConexao({
    restrito: true,
    sessaoEhMinha: false,
    sessaoTemResponsaveis: true,
    conversaAbertaEMinha: conversaAberta(c?.status) && c?.assigned_to_user_id === p.userId,
  });
}
