/**
 * O worker das mensagens agendadas (migration 1017), sobre um banco em memória
 * que aplica os filtros de verdade. A reserva (`fn_reservar_mensagens_agendadas`)
 * é reimplementada com a regra da migration: vencida, `agendada`, fora das
 * organizações paradas, vira `enviando`. A prova em Postgres é
 * `tests/invariants/mensagens-agendadas-rls-e-check.test.ts`.
 *
 * A porta de envio, o espaçamento e a janela de horário entram como dublês
 * injetados: são a fronteira desta unidade, com testes próprios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: vi.fn() }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { criarBancoEmMemoria, type Linha } from "@/tests/helpers/banco-em-memoria";
import { ApiError } from "@/lib/api/types";
import {
  MOTIVO_OPT_OUT,
  MOTIVO_PRESA,
  MOTIVO_SEM_AUTOR,
  rodarMensagensAgendadas,
  houveEfeito,
  type DepsDoWorker,
} from "@/lib/mensagens-agendadas/worker";
import { MOTIVO_SEM_MODELO } from "@/lib/mensagens-agendadas/regras";

const AGORA = new Date("2026-11-17T12:00:00Z");
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PARADA = "bbbbbbbb-0000-4000-8000-000000000002";
const ANA = "aaaaaaaa-1111-4000-8000-000000000001";
const CANAL = "aaaaaaaa-2222-4000-8000-000000000001";
const CONTATO = "aaaaaaaa-3333-4000-8000-000000000001";
const CONVERSA = "aaaaaaaa-4444-4000-8000-000000000001";

function agendada(id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    conversation_id: CONVERSA,
    contact_id: CONTATO,
    channel_session_id: CANAL,
    created_by: ANA,
    body: "Oi, tudo certo para amanhã?",
    template: null,
    send_at: "2026-11-17T11:59:00Z",
    status: "agendada",
    motivo: null,
    message_id: null,
    adiada_ate: null,
    reservada_em: null,
    ...extra,
  };
}

function montar(opcoes: { provider?: string; lastInbound?: string | null; bloqueado?: boolean; papel?: string | null; linhas: Linha[] }) {
  const tabelas: Record<string, Linha[]> = {
    organizations: [
      { id: ORG, status: "active" },
      { id: PARADA, status: "suspended" },
    ],
    conversations: [
      { id: CONVERSA, organization_id: ORG, contact_id: CONTATO, channel_session_id: CANAL, last_inbound_at: opcoes.lastInbound ?? "2026-11-17T11:00:00Z" },
    ],
    contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: opcoes.bloqueado ?? false, is_anonymized: false }],
    user_organizations:
      opcoes.papel === null ? [] : [{ user_id: ANA, organization_id: ORG, role: opcoes.papel ?? "agent", revoked_at: null }],
    channel_sessions: [{ id: CANAL, organization_id: ORG, provider: opcoes.provider ?? "meta_cloud" }],
    scheduled_messages: opcoes.linhas,
    agent_inbox_items: [],
  };
  const banco = criarBancoEmMemoria(tabelas, {
    rpc: {
      fn_reservar_mensagens_agendadas: (args) => {
        const paradas = (args.p_orgs_paradas as string[]) ?? [];
        const reservadas = tabelas.scheduled_messages!
          .filter(
            (l) =>
              l.status === "agendada" &&
              String(l.send_at) <= AGORA.toISOString() &&
              (!l.adiada_ate || String(l.adiada_ate) <= AGORA.toISOString()) &&
              !paradas.includes(String(l.organization_id)),
          )
          .slice(0, Number(args.p_limite));
        for (const l of reservadas) Object.assign(l, { status: "enviando", reservada_em: AGORA.toISOString() });
        return { data: reservadas.map((l) => ({ ...l })) };
      },
    },
  });
  return { banco, tabelas, admin: banco as unknown as SupabaseClient };
}

let enviados: Array<Record<string, unknown>>;
let deps: DepsDoWorker;

beforeEach(() => {
  enviados = [];
  deps = {
    enviar: (async (_db: unknown, ctx: { actor: unknown }, input: Record<string, unknown>) => {
      enviados.push({ ...input, actor: ctx.actor });
      return { id: `msg-${enviados.length}`, status: "sent" };
    }) as unknown as DepsDoWorker["enviar"],
    espacar: vi.fn(async () => undefined),
    adiar: vi.fn(async () => null),
  };
});

const linha = (tabelas: Record<string, Linha[]>, id: string) => tabelas.scheduled_messages!.find((l) => l.id === id)!;

describe("rodarMensagensAgendadas", () => {
  it("envia o texto em nome de quem agendou, uma vez só, e a segunda rodada não repete", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1")] });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(r.enviadas).toBe(1);
    expect(enviados).toEqual([
      expect.objectContaining({ type: "text", body: "Oi, tudo certo para amanhã?", actor: { type: "user", id: ANA, role: "agent" } }),
    ]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "enviada", message_id: "msg-1" });
    expect(deps.espacar).toHaveBeenCalledWith(CANAL);

    const segunda = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(segunda.reservadas).toBe(0);
    expect(enviados).toHaveLength(1);
    expect(houveEfeito(segunda)).toBe(false);
  });

  it("janela fechada com modelo: sai o modelo", async () => {
    const modelo = { name: "retomada", language: "pt_BR", values: { "1": "Ana" }, body: "Oi {{1}}" };
    const { admin } = montar({ lastInbound: "2026-11-15T10:00:00Z", linhas: [agendada("s1", { template: modelo })] });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados[0]).toMatchObject({ type: "template", template_name: "retomada", template_values: { "1": "Ana" } });
  });

  it("janela fechada sem modelo: não envia, grava a falha e abre UM aviso na Central", async () => {
    const { admin, tabelas } = montar({
      lastInbound: "2026-11-15T10:00:00Z",
      linhas: [agendada("s1"), agendada("s2")],
    });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(r.falhas).toBe(2);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "falhou", motivo: MOTIVO_SEM_MODELO });
    expect(tabelas.agent_inbox_items).toHaveLength(1);
    expect(tabelas.agent_inbox_items![0]).toMatchObject({
      organization_id: ORG,
      kind: "message_send_stuck",
      ref_kind: "conversation",
      ref_id: CONVERSA,
    });
  });

  it("contato bloqueado (opt-out) na hora: cancela com o motivo e não envia", async () => {
    const { admin, tabelas } = montar({ bloqueado: true, linhas: [agendada("s1")] });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(r.canceladas).toBe(1);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_OPT_OUT });
    expect(tabelas.agent_inbox_items).toHaveLength(0);
  });

  it("quem agendou saiu da equipe: cancela, nada sai em nome dele", async () => {
    const { admin, tabelas } = montar({ papel: null, linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_SEM_AUTOR });
  });

  it("fora do horário da conexão: volta a agendada com a próxima abertura, sem efeito", async () => {
    deps.adiar = vi.fn(async () => "2026-11-18T10:00:00.000Z");
    const { admin, tabelas } = montar({ linhas: [agendada("s1")] });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "agendada", adiada_ate: "2026-11-18T10:00:00.000Z" });
    expect(houveEfeito(r)).toBe(false);
  });

  it("organização parada não tem a linha reservada", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1", { organization_id: PARADA })] });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(r.reservadas).toBe(0);
    expect(linha(tabelas, "s1").status).toBe("agendada");
  });

  it("recusa da porta de envio vira falha com a frase dela", async () => {
    deps.enviar = (async () => {
      throw new ApiError(403, "forbidden", undefined, "r", "Contato marcado como pessoal.");
    }) as unknown as DepsDoWorker["enviar"];
    const { admin, tabelas } = montar({ linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "falhou", motivo: "Contato marcado como pessoal." });
    expect(tabelas.agent_inbox_items).toHaveLength(1);
  });

  it("linha presa em enviando há mais de 10 min vira falha, sem reenvio", async () => {
    const { admin, tabelas } = montar({
      linhas: [agendada("s1", { status: "enviando", reservada_em: "2026-11-17T11:30:00Z" })],
    });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(r.presas).toBe(1);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "falhou", motivo: MOTIVO_PRESA });
    expect(tabelas.agent_inbox_items).toHaveLength(1);
  });
});
