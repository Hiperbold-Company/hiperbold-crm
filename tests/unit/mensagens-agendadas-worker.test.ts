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
  MOTIVO_ANONIMIZADO,
  MOTIVO_MODELO_NAO_APROVADO,
  MOTIVO_OPT_OUT,
  MOTIVO_PRESA,
  MOTIVO_SEM_AUTOR,
  MOTIVO_SEM_PERMISSAO,
  MOTIVO_SEM_VISIBILIDADE,
  RESERVAS_POR_ORG_POR_RODADA,
  RESERVAS_POR_RODADA,
  rodarMensagensAgendadas,
  houveEfeito,
  type DepsDoWorker,
} from "@/lib/mensagens-agendadas/worker";
import { MOTIVO_SEM_MODELO, PRAZO_DA_RODADA_MS, PRESA_APOS_MS } from "@/lib/mensagens-agendadas/regras";

const AGORA = new Date("2026-11-17T12:00:00Z");
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PARADA = "bbbbbbbb-0000-4000-8000-000000000002";
const ANA = "aaaaaaaa-1111-4000-8000-000000000001";
const CANAL = "aaaaaaaa-2222-4000-8000-000000000001";
const CONTATO = "aaaaaaaa-3333-4000-8000-000000000001";
const CONVERSA = "aaaaaaaa-4444-4000-8000-000000000001";
const BETO = "aaaaaaaa-1111-4000-8000-000000000002";
const WABA = "WABA-1";

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

function montar(opcoes: {
  provider?: string;
  lastInbound?: string | null;
  bloqueado?: boolean;
  papel?: string | null;
  settings?: Record<string, unknown>;
  atribuidaA?: string | null;
  pessoal?: boolean;
  participantes?: Linha[];
  modelos?: Linha[];
  linhas: Linha[];
}) {
  const tabelas: Record<string, Linha[]> = {
    organizations: [
      { id: ORG, status: "active", settings: opcoes.settings ?? {} },
      { id: PARADA, status: "suspended", settings: {} },
    ],
    conversations: [
      {
        id: CONVERSA,
        organization_id: ORG,
        contact_id: CONTATO,
        channel_session_id: CANAL,
        last_inbound_at: opcoes.lastInbound ?? "2026-11-17T11:00:00Z",
        assigned_to_user_id: opcoes.atribuidaA === undefined ? ANA : opcoes.atribuidaA,
      },
    ],
    contacts: [
      { id: CONTATO, organization_id: ORG, is_blocked: opcoes.bloqueado ?? false, is_anonymized: false, is_personal: opcoes.pessoal ?? false },
    ],
    user_organizations:
      opcoes.papel === null ? [] : [{ user_id: ANA, organization_id: ORG, role: opcoes.papel ?? "agent", revoked_at: null }],
    channel_sessions: [{ id: CANAL, organization_id: ORG, provider: opcoes.provider ?? "meta_cloud", meta_waba_id: WABA }],
    conversation_participants: opcoes.participantes ?? [],
    meta_templates: opcoes.modelos ?? [],
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
          .sort((a, b) => String(a.send_at).localeCompare(String(b.send_at)))
          .slice(0, Number(args.p_limite));
        for (const l of reservadas) Object.assign(l, { status: "enviando", reservada_em: AGORA.toISOString() });
        return { data: reservadas.map((l) => ({ ...l })) };
      },
    },
  });
  return { banco, tabelas, admin: banco as unknown as SupabaseClient };
}

function modeloDoEspelho(name: string, status: string): Linha {
  return {
    id: `tpl-${name}`,
    organization_id: ORG,
    name,
    language: "pt_BR",
    status,
    components: [{ type: "BODY", text: "Oi {{1}}, voltamos a falar?" }],
    channel_session_id: null,
    waba_id: WABA,
  };
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

  it("janela fechada com modelo: sai o modelo APROVADO da conexão, com o texto da definição", async () => {
    const modelo = { name: "retomada", language: "pt_BR", values: { "1": "Ana" }, body: "texto que o navegador mandou" };
    const { admin } = montar({
      lastInbound: "2026-11-15T10:00:00Z",
      modelos: [modeloDoEspelho("retomada", "APPROVED")],
      linhas: [agendada("s1", { template: modelo })],
    });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados[0]).toMatchObject({
      type: "template",
      template_name: "retomada",
      template_values: { "1": "Ana" },
      body: "Oi {{1}}, voltamos a falar?",
    });
  });

  it("modelo pausado (ou de outra conta) na hora do envio: não envia e falha com o motivo", async () => {
    const modelo = { name: "retomada", language: "pt_BR", values: {}, body: "x" };
    for (const espelho of [
      [modeloDoEspelho("retomada", "PAUSED")],
      [{ ...modeloDoEspelho("retomada", "APPROVED"), waba_id: "OUTRA-WABA" }],
      [],
    ]) {
      enviados = [];
      const { admin, tabelas } = montar({
        lastInbound: "2026-11-15T10:00:00Z",
        modelos: espelho,
        linhas: [agendada("s1", { template: modelo })],
      });
      await rodarMensagensAgendadas(admin, AGORA, "req", deps);
      expect(enviados).toEqual([]);
      expect(linha(tabelas, "s1")).toMatchObject({ status: "falhou", motivo: MOTIVO_MODELO_NAO_APROVADO });
    }
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

describe("revalidação de quem agendou, na hora do envio", () => {
  it("perdeu chat.responder pelas permissões da organização: cancela sem enviar", async () => {
    const { admin, tabelas } = montar({ settings: { permissoes: { "chat.responder": ["manager"] } }, linhas: [agendada("s1")] });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(r.canceladas).toBe(1);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_SEM_PERMISSAO });
  });

  it("modo 'só os meus' e a conversa passou a outro atendente: cancela sem enviar", async () => {
    const { admin, tabelas } = montar({ settings: { visibility_mode: "own" }, atribuidaA: BETO, linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_SEM_VISIBILIDADE });
  });

  it("modo padrão: a conversa de outro atendente não é visível, a sem dono é", async () => {
    const outro = montar({ atribuidaA: BETO, linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(outro.admin, AGORA, "req", deps);
    expect(linha(outro.tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_SEM_VISIBILIDADE });

    const semDono = montar({ atribuidaA: null, linhas: [agendada("s2")] });
    await rodarMensagensAgendadas(semDono.admin, AGORA, "req", deps);
    expect(linha(semDono.tabelas, "s2")).toMatchObject({ status: "enviada" });
  });

  it("modo 'só os meus' com o autor participante ativo envia; contato pessoal não", async () => {
    const participa = [{ conversation_id: CONVERSA, organization_id: ORG, user_id: ANA, left_at: null }];
    const ok = montar({ settings: { visibility_mode: "own" }, atribuidaA: BETO, participantes: participa, linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(ok.admin, AGORA, "req", deps);
    expect(linha(ok.tabelas, "s1")).toMatchObject({ status: "enviada" });

    const pessoal = montar({
      settings: { visibility_mode: "own" },
      atribuidaA: BETO,
      pessoal: true,
      participantes: participa,
      linhas: [agendada("s2")],
    });
    await rodarMensagensAgendadas(pessoal.admin, AGORA, "req", deps);
    expect(linha(pessoal.tabelas, "s2")).toMatchObject({ status: "cancelada", motivo: MOTIVO_SEM_VISIBILIDADE });
  });

  it("gerente enxerga a conversa de qualquer atendente, mesmo em 'só os meus'", async () => {
    const { admin, tabelas } = montar({ papel: "manager", settings: { visibility_mode: "own" }, atribuidaA: BETO, linhas: [agendada("s1")] });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "enviada" });
  });
});

describe("reserva justa entre organizações", () => {
  const OUTRA = "cccccccc-0000-4000-8000-000000000003";

  it(`uma organização reserva no máximo ${RESERVAS_POR_ORG_POR_RODADA} por rodada, e a outra entra na mesma rodada`, async () => {
    // A org grande tem as linhas MAIS ANTIGAS: sem o teto, ocuparia as 20 reservas.
    const grandes = Array.from({ length: 30 }, (_, i) =>
      agendada(`g${i}`, { send_at: `2026-11-17T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    const pequenas = Array.from({ length: 3 }, (_, i) =>
      agendada(`p${i}`, { organization_id: OUTRA, send_at: "2026-11-17T11:50:00Z" }),
    );
    const { admin, tabelas } = montar({ linhas: [...grandes, ...pequenas] });
    tabelas.organizations!.push({ id: OUTRA, status: "active", settings: {} });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    const daGrande = tabelas.scheduled_messages!.filter((l) => l.organization_id === ORG && l.status !== "agendada");
    const daOutra = tabelas.scheduled_messages!.filter((l) => l.organization_id === OUTRA && l.status !== "agendada");
    expect(daGrande).toHaveLength(RESERVAS_POR_ORG_POR_RODADA);
    expect(daOutra).toHaveLength(3);
    expect(r.reservadas).toBe(RESERVAS_POR_ORG_POR_RODADA + 3);
    expect(r.reservadas).toBeLessThanOrEqual(RESERVAS_POR_RODADA);
    // As que ficaram de fora seguem intactas na fila, sem `updated_at` mexido.
    expect(tabelas.scheduled_messages!.filter((l) => l.status === "agendada")).toHaveLength(25);
  });
});

describe("o lease: linha em envio não vira presa", () => {
  it("presa mais velha que o prazo vira falha; a de lease recente fica com a rodada que a envia", async () => {
    const recente = new Date(AGORA.getTime() - PRESA_APOS_MS / 2).toISOString();
    const { admin, tabelas } = montar({
      linhas: [agendada("s1", { status: "enviando", reservada_em: recente })],
    });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(r.presas).toBe(0);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "enviando" });
  });

  it("o lease é renovado antes do envio; se outra rodada já deu a linha como presa, nada sai", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1"), agendada("s2", { send_at: "2026-11-17T11:59:30Z" })] });
    let chamadas = 0;
    deps.relogio = () => new Date(AGORA.getTime() + 1000);
    deps.espacar = vi.fn(async () => {
      chamadas += 1;
      // Durante a espera do s2, uma rodada sobreposta o marcou como presa.
      if (chamadas === 2) Object.assign(linha(tabelas, "s2"), { status: "falhou", motivo: MOTIVO_PRESA });
    });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toHaveLength(1);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "enviada", reservada_em: new Date(AGORA.getTime() + 1000).toISOString() });
    expect(linha(tabelas, "s2")).toMatchObject({ status: "falhou", motivo: MOTIVO_PRESA });
  });

  it("passado o prazo da rodada, o que não foi enviado volta para a fila", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1"), agendada("s2", { send_at: "2026-11-17T11:59:30Z" })] });
    let t = AGORA.getTime();
    deps.relogio = () => new Date(t);
    deps.enviar = (async (_db: unknown, _ctx: unknown, input: Record<string, unknown>) => {
      enviados.push(input);
      t += PRAZO_DA_RODADA_MS + 1;
      return { id: "msg-1", status: "sent" };
    }) as unknown as DepsDoWorker["enviar"];
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toHaveLength(1);
    expect(linha(tabelas, "s1").status).toBe("enviada");
    expect(linha(tabelas, "s2")).toMatchObject({ status: "agendada", reservada_em: null });
    expect(r.adiadas).toBe(1);
  });

  // A cascata LGPD redige a linha e anonimiza o contato SEM tirar o status `enviando`: o lease
  // renovado ainda a alcança. A releitura antes do envio é o que impede o texto apagado de sair.
  it("anonimizado durante a espera do envio: o texto redigido não sai e a linha é cancelada", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1")] });
    deps.espacar = vi.fn(async () => {
      Object.assign(linha(tabelas, "s1"), { body: "[mensagem anonimizada]", template: null });
      Object.assign(tabelas.contacts![0]!, { is_anonymized: true });
    });
    const r = await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(r.canceladas).toBe(1);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_ANONIMIZADO });
  });

  it("modelo redigido durante a espera (template apagado): não envia o modelo antigo", async () => {
    const modelo = { name: "retomada", language: "pt_BR", values: { "1": "Ana" }, body: "x" };
    const { admin, tabelas } = montar({
      lastInbound: "2026-11-15T10:00:00Z",
      modelos: [modeloDoEspelho("retomada", "APPROVED")],
      linhas: [agendada("s1", { template: modelo })],
    });
    deps.espacar = vi.fn(async () => {
      Object.assign(linha(tabelas, "s1"), { template: null });
    });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_ANONIMIZADO });
  });

  it("opt-out durante a espera do envio: cancela com o motivo do opt-out", async () => {
    const { admin, tabelas } = montar({ linhas: [agendada("s1")] });
    deps.espacar = vi.fn(async () => {
      Object.assign(tabelas.contacts![0]!, { is_blocked: true });
    });
    await rodarMensagensAgendadas(admin, AGORA, "req", deps);
    expect(enviados).toEqual([]);
    expect(linha(tabelas, "s1")).toMatchObject({ status: "cancelada", motivo: MOTIVO_OPT_OUT });
  });
});
