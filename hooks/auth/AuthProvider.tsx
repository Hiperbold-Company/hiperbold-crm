"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Providers } from "@/app/providers";
import { createClient, resetRealtimeAuthentication } from "@/lib/supabase/browser";
import type { AuthUser, ActiveOrg, Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";
import { ehChaveDePermissao, type ChaveDePermissao } from "@/lib/permissoes/catalogo";
import { papelPode } from "@/lib/permissoes/resolver";

interface AuthCtx {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  isAuthenticated: true;
  refreshing: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({
  user,
  activeOrg,
  children,
}: {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    resetRealtimeAuthentication();
    return resetRealtimeAuthentication;
  }, [user.id, activeOrg?.orgId, user.support?.id, user.support?.access_mode]);

  // Revogação/scope no banco também derrubam o snapshot aberto de UI/realtime.
  useEffect(() => {
    if (!user.support) return;
    const expected = `${user.support.id}:${user.support.access_mode}:${user.support.status}`;
    const check = async () => {
      const response = await fetch("/api/v1/auth/support", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const result = await response.json();
      if (result.data.signature !== expected) window.location.reload();
    };
    const timer = setInterval(() => { void check(); }, 15000);
    return () => clearInterval(timer);
  }, [user.support]);

  // Refresh session every 40 minutes (JWT default 1h, with margin).
  useEffect(() => {
    const interval = setInterval(
      async () => {
        setRefreshing(true);
        try {
          await supabaseRef.current.auth.refreshSession();
        } finally {
          setRefreshing(false);
        }
      },
      40 * 60 * 1000,
    );
    return () => clearInterval(interval);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      activeOrg,
      isAuthenticated: true,
      refreshing,
      signOut: async () => {
        resetRealtimeAuthentication();
        const { signOut } = await import("@/app/actions/auth/signOut");
        await signOut();
      },
    }),
    [user, activeOrg, refreshing],
  );

  return <Ctx.Provider value={value}>
    <Providers key={`${user.id}:${activeOrg?.orgId ?? "none"}:${user.support?.id ?? "normal"}:${user.support?.access_mode ?? ""}`}>{children}</Providers>
  </Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useUser(): AuthUser {
  return useAuth().user;
}

/**
 * O fuso IANA da organização ativa, ou `null` (o consumidor cai no do navegador).
 *
 * Tolerante à falta de provider de propósito: o quadro e a ficha desenham datas
 * também em telas de amostra e em testes, e lançar ali por causa de um rótulo de
 * data seria o remédio pior que a doença.
 */
export function useFusoDaOrganizacao(): string | null {
  return useContext(Ctx)?.activeOrg?.timezone ?? null;
}

export function useActiveOrg(): ActiveOrg | null {
  return useAuth().activeOrg;
}

/**
 * Permission gate based on role rank. Action mapping is intentionally
 * minimal here — feature-specific gates can extend with custom logic.
 */
const ACTION_MIN_ROLE: Record<string, Role> = {
  "inbox.view": "viewer",
  "inbox.reply": "agent",
  "inbox.claim": "agent",
  "contact.view": "viewer",
  "contact.create": "agent",
  "contact.update": "agent",
  "contact.delete": "manager",
  // Tela Contatos: seleção em lote, "Excluir" do lote (`POST /api/v1/contacts/bulk-delete`) e
  // "Exportar CSV" (`POST /api/v1/contacts/export`) são de gerência: as duas rotas exigem `manager`.
  // O atendente segue com a lixeira de UM contato (`DELETE /api/v1/contacts/[id]`, `agent`). A rota
  // é quem barra — isto só esconde o botão.
  "contact.bulk_delete": "manager",
  "contact.export": "manager",
  "pipeline.view": "viewer",
  "pipeline.create": "manager",
  "pipeline.move_card": "agent",
  // "Registrar evento" na ficha do negócio: mesmo piso da rota (requireRole agent).
  "lead.activity.log": "agent",
  // "Produtos" na ficha do negócio: adicionar, alterar e remover itens. Mesmo piso das rotas
  // `/api/v1/leads/[id]/itens` (requireRole agent); a rota é quem barra.
  "lead.items.edit": "agent",
  "team.invite": "admin",
  "team.change_role": "admin",
  "settings.write": "admin",
  "lgpd.execute_redact": "admin",
  "audit.view": "manager",
  "ai.automatico.view": "agent",
  "ai.inbox.view": "agent",
  "inbox.notes.view": "agent",
  // O cartão da passagem, dentro da conversa. `agent` e não `viewer` porque é o
  // piso que a policy de `passagens_de_atendimento` exige (migration 0291): o
  // briefing diz MAIS que a conversa — diz o que a IA concluiu sobre a pessoa.
  // Um `viewer` que sondasse esta rota levaria 403 em toda abertura de conversa.
  "inbox.passagens.view": "agent",
  "message-templates.view": "agent",
  "ai.agents.view": "manager",
  "ai.agents.write": "admin",
  "ai.memory.view": "manager",
  "ai.memory.publish": "admin",
  "ai.skills.view": "manager",
  "ai.skills.manage": "manager",
  "ai.routers.view": "manager",
  "ai.evolution.view": "manager",
  "ai.routers.manage": "admin",
  "ai.credentials.view": "manager",
  "ai.credentials.write": "admin",
  "webhooks.manage": "manager",
  // Mesmo mínimo de lib/navigation/catalogo.ts (destino /app/calls) e de
  // requireRole("manager") em app/api/v1/calls/route.ts — a RLS de crm_calls
  // é só por organização, então sem este gate o aviso ao vivo de ligação
  // chegaria pra viewer/agent, papéis que a tela nunca mostra pra eles.
  "calls.view": "manager",
  // Chamada de voz (spec 18). `agent` porque ligar e atender é ato de
  // atendimento, não de configuração — e porque é o piso que as rotas de
  // `app/api/v1/voice/calls/*` exigem. Quem não alcança este piso (viewer, e
  // acompanhamento administrativo somente-leitura, que é rebaixado a viewer em
  // `resolveActiveOrg`) não sonda, não assina e não vê telefone tocar: um
  // banner de chamada para quem não pode atendê-la é uma promessa falsa, e a
  // sondagem por trás dele levava 403 em toda navegação.
  "voice.call": "agent",
};

/**
 * Ações deste mapa que passaram a obedecer às PERMISSÕES POR PERFIL
 * (`lib/permissoes/catalogo.ts`): para elas o papel mínimo acima deixa de
 * valer, e quem decide é a escolha da organização (padrão = o de antes).
 *
 * `inbox.reply` fica FORA de propósito: hoje quem o consulta é a Agenda
 * (`EntradaDaAgenda`), para editar compromisso — ligá-lo a "Responder
 * conversas" faria tirar o chat do gerente tirar também a agenda. O Chat
 * consulta a chave `chat.responder` direto.
 */
const ACAO_PARA_PERMISSAO: Record<string, ChaveDePermissao> = {
  "contact.export": "contatos.exportar",
  "contact.bulk_delete": "contatos.excluir_em_lote",
  "pipeline.create": "funis.editar",
  "pipeline.move_card": "negocios.mover",
  "lead.activity.log": "negocios.registrar",
  "lead.items.edit": "negocios.registrar",
};

/**
 * Esconde ou mostra um botão. NÃO é autorização: quem barra é a rota
 * (`requireRole` / `exigirPermissao`). Aceita as ações do mapa acima ou uma
 * chave do catálogo de permissões (`"contatos.importar"`).
 */
export function usePermission(action: string): boolean {
  const { user, activeOrg } = useAuth();
  if (user.is_platform_admin && !user.support) return true;
  if (!activeOrg) return false;
  const chave = ehChaveDePermissao(action) ? action : ACAO_PARA_PERMISSAO[action];
  if (chave) return papelPode(activeOrg.role, chave, activeOrg.permissoes);
  const required = ACTION_MIN_ROLE[action];
  if (!required) return false;
  return ROLE_RANK[activeOrg.role] >= ROLE_RANK[required];
}
