/**
 * Uma automação iniciando outra (lote 3, unidade 2): a ação `start_automation`,
 * o gatilho `started_by_automation`, `{{param.x}}`, os eventos legíveis e o
 * publish.
 *
 * O efeito roda pelo executor de produção (`criarExecutorDeEfeitos`) contra um
 * banco em memória que FILTRA de verdade por organização. A única peça
 * simulada é a borda do banco: `fn_automacao_iniciar`, reproduzida com as
 * regras que este efeito depende dela (idempotência por origem, cadeia pelo
 * `parent_enrollment_id`, ciclo, profundidade 5, inativa, contato de outra org).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { PedidoDeEfeito } from "@/lib/followup/engine";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import type { FlowGraph, FlowNode, NovaConditionCheck } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { avaliarRegraNova } from "./condicoes";
import { criarExecutorDeEfeitos } from "./efeitos";
import { EVENTO_INICIADA_PELA_AUTOMACAO, origemDoInicio } from "./efeitos/iniciar-automacao";
import type { FatosDaAutomacao } from "./fatos";
import { aceitaIniciador, casaGatilho, type FatoDeGatilho } from "./gatilhos";
import { referenciasDoGrafo } from "./referencias";
import {
  automacaoTriggerSchema,
  crmActionSchema,
  type AutomacaoTriggerConfig,
  type CrmAction,
} from "./schemas";
import { renderizar } from "./template-vars";
import { fraseDoErro } from "./vocabulario";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_ORG = "00000000-0000-4000-8000-0000000000b2";
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const C = "10000000-0000-4000-8000-000000000003";
const DE_FORA = "10000000-0000-4000-8000-000000000099";
const CONTATO = "20000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-11-03T15:00:00Z");

// ---------------------------------------------------------------------------
// Banco em memória
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;

function grafoCom(triggers: AutomacaoTriggerConfig["triggers"]): FlowGraph {
  return {
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers, reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      {
        id: "n2",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 200 },
        config: { outcome: "converted" },
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2", priority: 0, condition: { type: "always" } }],
  } as FlowGraph;
}

function criarBanco(over: { pointers?: Linha[]; versions?: Linha[]; enrollments?: Linha[] } = {}) {
  const t: Record<string, Linha[]> = {
    followup_flow_pointers: over.pointers ?? [
      {
        id: A,
        organization_id: ORG,
        name: "Boas-vindas",
        surface: "automacao",
        status: "active",
        active_version_id: "vA",
      },
      {
        id: B,
        organization_id: ORG,
        name: "Qualificação",
        surface: "automacao",
        status: "active",
        active_version_id: "vB",
      },
      {
        id: C,
        organization_id: ORG,
        name: "Pós-venda",
        surface: "automacao",
        status: "active",
        active_version_id: "vC",
      },
      {
        id: DE_FORA,
        organization_id: OUTRA_ORG,
        name: "Alheia",
        surface: "automacao",
        status: "active",
        active_version_id: "vX",
      },
    ],
    followup_flow_versions: over.versions ?? [
      { id: "vA", organization_id: ORG, graph: grafoCom([{ kind: "manual" }]) },
      { id: "vB", organization_id: ORG, graph: grafoCom([{ kind: "started_by_automation" }]) },
      {
        id: "vC",
        organization_id: ORG,
        graph: grafoCom([{ kind: "started_by_automation", from_pointer_ids: [B] }]),
      },
      {
        id: "vX",
        organization_id: OUTRA_ORG,
        graph: grafoCom([{ kind: "started_by_automation" }]),
      },
    ],
    followup_enrollments: over.enrollments ?? [],
    followup_enrollment_events: [],
    contacts: [{ id: CONTATO, organization_id: ORG, is_anonymized: false }],
  };
  const rpcs: Array<Record<string, unknown>> = [];
  let seq = 0;

  function fnAutomacaoIniciar(p: Record<string, unknown>): Linha {
    const org = p.p_org as string;
    const pointer = t.followup_flow_pointers!.find(
      (r) =>
        r.organization_id === org &&
        r.id === p.p_pointer &&
        r.surface === "automacao" &&
        r.status === "active",
    );
    if (!pointer) return { resultado: "inativa" };
    if (
      !t.contacts!.some(
        (c) => c.organization_id === org && c.id === p.p_contact && c.is_anonymized === false,
      )
    ) {
      return { resultado: "contato_invalido" };
    }
    if (
      p.p_origin_event_id &&
      t.followup_enrollments!.some(
        (e) => e.pointer_id === p.p_pointer && e.origin_event_id === p.p_origin_event_id,
      )
    ) {
      return { resultado: "duplicada" };
    }
    if (p.p_parent_enrollment_id) {
      let atual = t.followup_enrollments!.find(
        (e) => e.organization_id === org && e.id === p.p_parent_enrollment_id,
      );
      let n = 0;
      let ciclo = false;
      while (atual && n < 20) {
        n++;
        if (atual.pointer_id === p.p_pointer) ciclo = true;
        const pai = atual.parent_enrollment_id;
        atual = pai
          ? t.followup_enrollments!.find((e) => e.organization_id === org && e.id === pai)
          : undefined;
      }
      if (ciclo) return { resultado: "ciclo" };
      if (n >= 5) return { resultado: "cadeia_longa" };
    }
    const viva = t.followup_enrollments!.find(
      (e) =>
        e.organization_id === org &&
        e.pointer_id === p.p_pointer &&
        e.contact_id === p.p_contact &&
        e.status === "active",
    );
    if (viva) return { resultado: "ja_em_execucao", enrollment_id: viva.id };
    const id = `30000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    t.followup_enrollments!.push({
      id,
      organization_id: org,
      pointer_id: p.p_pointer,
      contact_id: p.p_contact,
      status: "active",
      vars: p.p_vars,
      origin_event_id: p.p_origin_event_id,
      parent_enrollment_id: p.p_parent_enrollment_id,
    });
    t.followup_enrollment_events!.push({
      organization_id: org,
      enrollment_id: id,
      event_type: "automacao_iniciada",
      payload: {
        gatilho: (p.p_vars as { gatilho?: { tipo?: string } }).gatilho?.tipo,
        reiniciada: false,
      },
      idempotency_key: "inicio",
    });
    return { resultado: "iniciada", enrollment_id: id };
  }

  const admin = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      const b = {
        select: () => b,
        eq(col: string, v: unknown) {
          filtros.push((l) => l[col] === v);
          return b;
        },
        in(col: string, vs: unknown[]) {
          filtros.push((l) => vs.includes(l[col]));
          return b;
        },
        async maybeSingle() {
          const linhas = (t[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
          return { data: linhas[0] ?? null, error: null };
        },
        async insert(linha: Linha) {
          const lista = (t[tabela] ??= []);
          const dup = lista.some(
            (l) =>
              l.enrollment_id === linha.enrollment_id &&
              l.idempotency_key &&
              l.idempotency_key === linha.idempotency_key,
          );
          if (!dup) lista.push(linha);
          return { data: null, error: dup ? { code: "23505" } : null };
        },
      };
      return b;
    },
    async rpc(nome: string, params: Record<string, unknown>) {
      rpcs.push({ nome, ...params });
      if (nome !== "fn_automacao_iniciar")
        return { data: null, error: { message: `rpc inesperada ${nome}` } };
      return { data: fnAutomacaoIniciar(params), error: null };
    },
  };
  return { admin: admin as unknown as SupabaseClient, t, rpcs };
}

const FATOS = {
  contato: {
    id: CONTATO,
    name: "Maria Souza",
    email: null,
    phone_number: null,
    birthdate: null,
    tags: [],
    custom_fields: {},
  },
  negocio: null,
  negocios: [],
  vars: { resposta: { plano: "ouro" } },
} as unknown as FatosDaAutomacao;

function noDeIniciar(acoes: CrmAction[]): FlowNode {
  return {
    id: "acao-1",
    type: "crm_action",
    label: "Passar para a qualificação",
    position: { x: 0, y: 0 },
    config: { actions: acoes, on_error: "route" },
  } as FlowNode;
}

function pedido(
  enrollment: Partial<EnrollmentRow> & { id: string; pointer_id: string },
  acoes: CrmAction[],
  chave = "acao-1:3",
): PedidoDeEfeito {
  return {
    enrollment: { organization_id: ORG, contact_id: CONTATO, ...enrollment } as EnrollmentRow,
    node: noDeIniciar(acoes),
    fatos: FATOS,
    chave,
  };
}

const executor = (admin: SupabaseClient) =>
  criarExecutorDeEfeitos(admin, { clock: () => AGORA, podeProduzir: async () => true });

const iniciarB: CrmAction = {
  type: "start_automation",
  pointer_id: B,
  params: [
    { key: "nome", value: "{{contact.name}}" },
    { key: "plano", value: "{{resposta.plano}}" },
  ],
};

// ---------------------------------------------------------------------------

describe("schema da ação start_automation", () => {
  it("aceita até 10 dados com chave a-z0-9_ e valor até 1000", () => {
    expect(crmActionSchema.safeParse(iniciarB).success).toBe(true);
    expect(
      crmActionSchema.safeParse({ type: "start_automation", pointer_id: B, params: [] }).success,
    ).toBe(true);
  });

  it("recusa chave inválida, repetida, mais de 10 dados, valor longo e destino que não é uuid", () => {
    const com = (params: unknown, pointer_id: string = B) =>
      crmActionSchema.safeParse({ type: "start_automation", pointer_id, params }).success;
    expect(com([{ key: "Nome", value: "x" }])).toBe(false);
    expect(com([{ key: "nome-completo", value: "x" }])).toBe(false);
    expect(com([{ key: "a".repeat(41), value: "x" }])).toBe(false);
    expect(
      com([
        { key: "a", value: "1" },
        { key: "a", value: "2" },
      ]),
    ).toBe(false);
    expect(com(Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: "v" })))).toBe(false);
    expect(com([{ key: "a", value: "x".repeat(1001) }])).toBe(false);
    expect(com([], "nao-e-uuid")).toBe(false);
  });
});

describe("gatilho started_by_automation", () => {
  it("o schema aceita sem lista e com até 20 automações", () => {
    expect(automacaoTriggerSchema.safeParse({ kind: "started_by_automation" }).success).toBe(true);
    expect(
      automacaoTriggerSchema.safeParse({ kind: "started_by_automation", from_pointer_ids: [A] })
        .success,
    ).toBe(true);
    const muitos = Array.from(
      { length: 21 },
      (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(
      automacaoTriggerSchema.safeParse({ kind: "started_by_automation", from_pointer_ids: muitos })
        .success,
    ).toBe(false);
  });

  it("nenhum evento do log o casa", () => {
    const fatos: FatoDeGatilho[] = [
      {
        tipo: "lead_created",
        lead_id: "l",
        pipeline_id: null,
        stage_id: null,
        from_stage_id: null,
        fonte_id: null,
        causado_pela_automacao: A,
      },
      { tipo: "birthday", contact_id: CONTATO, data: null, causado_pela_automacao: null },
      {
        tipo: "case_opened",
        case_id: "c",
        conversation_id: null,
        contact_id: CONTATO,
        lead_id: null,
        causado_pela_automacao: A,
      },
    ];
    for (const f of fatos)
      expect(casaGatilho({ kind: "started_by_automation" }, f, true)).toBe(false);
  });

  it("a lista restringe o iniciador só quando todo gatilho do tipo traz lista", () => {
    const cfg = (triggers: AutomacaoTriggerConfig["triggers"]): AutomacaoTriggerConfig => ({
      triggers,
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    });
    expect(
      aceitaIniciador(cfg([{ kind: "started_by_automation", from_pointer_ids: [B] }]), B),
    ).toBe(true);
    expect(
      aceitaIniciador(cfg([{ kind: "started_by_automation", from_pointer_ids: [B] }]), A),
    ).toBe(false);
    expect(aceitaIniciador(cfg([{ kind: "started_by_automation", from_pointer_ids: [] }]), A)).toBe(
      true,
    );
    expect(aceitaIniciador(cfg([{ kind: "started_by_automation" }]), A)).toBe(true);
    expect(aceitaIniciador(cfg([{ kind: "manual" }]), A)).toBe(true);
    expect(
      aceitaIniciador(
        cfg([{ kind: "manual" }, { kind: "started_by_automation", from_pointer_ids: [B] }]),
        A,
      ),
    ).toBe(false);
    expect(aceitaIniciador(null, A)).toBe(true);
  });
});

describe("{{param.x}} no texto e na condição", () => {
  const fatos = {
    ...FATOS,
    vars: { param: { plano: "ouro", cupom: "BEMVINDO" } },
  } as FatosDaAutomacao;

  it("o template lê os dados passados; chave ausente vira vazio", () => {
    expect(
      renderizar("Plano {{param.plano}}, cupom {{ param.cupom }}.{{param.nada}}", fatos, AGORA),
    ).toBe("Plano ouro, cupom BEMVINDO.");
    expect(renderizar("{{param.plano}}", FATOS, AGORA)).toBe("");
  });

  it("a condição de campo lê var param.x", () => {
    const regra = (value: string) =>
      ({
        kind: "field",
        field: { scope: "var", path: "param.plano" },
        op: "eq",
        value,
      }) as unknown as NovaConditionCheck;
    expect(avaliarRegraNova(regra("ouro"), fatos)).toBe(true);
    expect(avaliarRegraNova(regra("prata"), fatos)).toBe(false);
  });
});

describe("efeito start_automation", () => {
  it("inicia o destino com os dados renderizados, a cadeia e a origem determinística — e sai por Concluído", async () => {
    const { admin, t, rpcs } = criarBanco({
      enrollments: [
        {
          id: "e-a",
          organization_id: ORG,
          pointer_id: A,
          contact_id: CONTATO,
          status: "active",
          parent_enrollment_id: null,
        },
      ],
    });
    const r = await executor(admin).executar(pedido({ id: "e-a", pointer_id: A }, [iniciarB]));
    expect(r.desfecho).toEqual({ ok: true });

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({
      p_org: ORG,
      p_pointer: B,
      p_contact: CONTATO,
      p_parent_enrollment_id: "e-a",
      p_origin_event_id: origemDoInicio("e-a", "acao-1:3", 0, B),
    });
    const nova = t.followup_enrollments!.find((e) => e.pointer_id === B)!;
    expect((nova.vars as Record<string, unknown>).param).toEqual({
      nome: "Maria Souza",
      plano: "ouro",
    });
    expect((nova.vars as { gatilho: Record<string, unknown> }).gatilho).toMatchObject({
      tipo: "started_by_automation",
      automacao_id: A,
    });

    // Destino: "Iniciada pela automação X", com as CHAVES e sem os valores.
    const ev = t.followup_enrollment_events!.find(
      (e) => e.event_type === EVENTO_INICIADA_PELA_AUTOMACAO,
    )!;
    expect(ev).toMatchObject({ organization_id: ORG, enrollment_id: nova.id });
    expect(ev.payload).toEqual({
      automacao_id: A,
      automacao_nome: "Boas-vindas",
      chaves: ["nome", "plano"],
    });
    // Origem: o detalhe do effect_done também só tem as chaves.
    expect(r.detalhes?.[0]).toMatchObject({
      tipo: "start_automation",
      resultado: "iniciada",
      automacao_nome: "Qualificação",
      ok: true,
    });
    const tudo = JSON.stringify([r.detalhes, t.followup_enrollment_events]);
    expect(tudo).not.toContain("Maria");
    expect(tudo).not.toContain("ouro");
  });

  it("replay do mesmo passo não abre segunda execução e segue por Concluído", async () => {
    const { admin, t } = criarBanco({
      enrollments: [
        {
          id: "e-a",
          organization_id: ORG,
          pointer_id: A,
          contact_id: CONTATO,
          status: "completed",
          parent_enrollment_id: null,
        },
      ],
    });
    const p = pedido({ id: "e-a", pointer_id: A }, [iniciarB]);
    await executor(admin).executar(p);
    // A execução de B terminou; o replay chega com a mesma chave de passo.
    t.followup_enrollments!.find((e) => e.pointer_id === B)!.status = "completed";
    const r2 = await executor(admin).executar(p);
    expect(r2.desfecho).toEqual({ ok: true });
    expect(r2.detalhes?.[0]).toMatchObject({ resultado: "duplicada" });
    expect(t.followup_enrollments!.filter((e) => e.pointer_id === B)).toHaveLength(1);

    // Outro passo (outra chave) é outro início.
    t.followup_enrollments!.find((e) => e.pointer_id === B)!.status = "completed";
    await executor(admin).executar(pedido({ id: "e-a", pointer_id: A }, [iniciarB], "acao-1:9"));
    expect(t.followup_enrollments!.filter((e) => e.pointer_id === B)).toHaveLength(2);
  });

  it("já em execução (política de reentrada) segue por Concluído", async () => {
    const { admin } = criarBanco({
      enrollments: [
        {
          id: "e-a",
          organization_id: ORG,
          pointer_id: A,
          contact_id: CONTATO,
          status: "active",
          parent_enrollment_id: null,
        },
        {
          id: "e-b",
          organization_id: ORG,
          pointer_id: B,
          contact_id: CONTATO,
          status: "active",
          parent_enrollment_id: null,
        },
      ],
    });
    const r = await executor(admin).executar(pedido({ id: "e-a", pointer_id: A }, [iniciarB]));
    expect(r.desfecho).toEqual({ ok: true });
    expect(r.detalhes?.[0]).toMatchObject({ resultado: "ja_em_execucao" });
  });

  it("ciclo A → B → A sai por Erro com motivo legível", async () => {
    const { admin, t } = criarBanco({
      enrollments: [
        {
          id: "e-a",
          organization_id: ORG,
          pointer_id: A,
          contact_id: CONTATO,
          status: "completed",
          parent_enrollment_id: null,
        },
        {
          id: "e-b",
          organization_id: ORG,
          pointer_id: B,
          contact_id: CONTATO,
          status: "active",
          parent_enrollment_id: "e-a",
        },
      ],
    });
    const voltarParaA: CrmAction = { type: "start_automation", pointer_id: A, params: [] };
    const r = await executor(admin).executar(pedido({ id: "e-b", pointer_id: B }, [voltarParaA]));
    expect(r.desfecho).toEqual({ ok: false, erro: "automacao_ciclo" });
    expect(fraseDoErro("automacao_ciclo")).toMatch(/ciclo/);
    expect(t.followup_enrollments!.filter((e) => e.pointer_id === A)).toHaveLength(1);
  });

  it("cadeia de 5 execuções é cortada", async () => {
    const cadeia = Array.from({ length: 5 }, (_, i) => ({
      id: `e-${i}`,
      organization_id: ORG,
      pointer_id: `90000000-0000-4000-8000-00000000000${i}`,
      contact_id: CONTATO,
      status: "active",
      parent_enrollment_id: i === 0 ? null : `e-${i - 1}`,
    }));
    const { admin } = criarBanco({ enrollments: cadeia });
    const r = await executor(admin).executar(
      pedido({ id: "e-4", pointer_id: "90000000-0000-4000-8000-000000000004" }, [iniciarB]),
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "automacao_cadeia_longa" });
    expect(fraseDoErro("automacao_cadeia_longa")).toMatch(/5 passos/);
  });

  it("automação de OUTRA organização não é encontrada e o banco nem é chamado", async () => {
    const { admin, rpcs, t } = criarBanco();
    const r = await executor(admin).executar(
      pedido({ id: "e-a", pointer_id: A }, [
        { type: "start_automation", pointer_id: DE_FORA, params: [] },
      ]),
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "automacao_inexistente" });
    expect(rpcs).toHaveLength(0);
    expect(t.followup_enrollments).toHaveLength(0);
  });

  it("a si mesma, inativa e fora da lista de iniciadores saem por Erro", async () => {
    const { admin, t, rpcs } = criarBanco();
    t.followup_flow_pointers!.find((p) => p.id === B)!.status = "disabled";
    const ex = executor(admin);
    const r1 = await ex.executar(
      pedido({ id: "e-a", pointer_id: A }, [
        { type: "start_automation", pointer_id: A, params: [] },
      ]),
    );
    expect(r1.desfecho).toEqual({ ok: false, erro: "automacao_propria" });
    const r2 = await ex.executar(pedido({ id: "e-a", pointer_id: A }, [iniciarB]));
    expect(r2.desfecho).toEqual({ ok: false, erro: "automacao_inativa" });
    // C só aceita ser iniciada por B.
    const r3 = await ex.executar(
      pedido({ id: "e-a", pointer_id: A }, [
        { type: "start_automation", pointer_id: C, params: [] },
      ]),
    );
    expect(r3.desfecho).toEqual({ ok: false, erro: "automacao_nao_aceita" });
    expect(rpcs).toHaveLength(0);
    for (const c of [
      "automacao_propria",
      "automacao_inativa",
      "automacao_nao_aceita",
      "automacao_contato_invalido",
      "automacao_limite_por_hora",
      "automacao_limite_da_organizacao",
      "automacao_em_espera",
      "automacao_sem_inicio",
      "automacao_inexistente",
    ]) {
      expect(fraseDoErro(c), c).not.toBe(c);
    }
  });
});

describe("eventos legíveis", () => {
  const ev = (event_type: string, payload: Record<string, unknown>) =>
    descreveEvento(
      { id: "x", node_id: null, event_type, payload, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
      "automacao",
    );

  it("no destino: iniciada pela automação X, com as chaves", () => {
    const d = ev(EVENTO_INICIADA_PELA_AUTOMACAO, {
      automacao_id: A,
      automacao_nome: "Boas-vindas",
      chaves: ["nome", "plano"],
    });
    expect(d.titulo).toBe("Iniciada pela automação “Boas-vindas”");
    expect(d.detalhe).toBe("dados recebidos: {{param.nome}}, {{param.plano}}");
    expect(ev("automacao_iniciada", { gatilho: "started_by_automation" }).detalhe).toBe(
      "outra automação a iniciou",
    );
  });

  it("na origem: iniciou a automação Y, ou o motivo do erro", () => {
    const feito = ev("effect_done", {
      desfecho: { ok: true },
      detalhes: [
        {
          tipo: "start_automation",
          automacao_nome: "Qualificação",
          resultado: "iniciada",
          chaves: ["nome"],
          ok: true,
        },
      ],
    });
    expect(feito.detalhe).toBe("Iniciou a automação “Qualificação”");
    const falhou = ev("effect_failed", {
      desfecho: { ok: false, erro: "automacao_ciclo" },
      detalhes: [
        {
          tipo: "start_automation",
          automacao_nome: "Boas-vindas",
          resultado: "ciclo",
          ok: false,
          erro: "automacao_ciclo",
        },
      ],
    });
    expect(falhou.detalhe).toContain("fecharia um ciclo");
    expect(falhou.detalhe).toContain("Iniciar outra automação");
  });
});

describe("publish", () => {
  function grafoQueInicia(pointer_id: string): FlowGraph {
    const g = grafoCom([{ kind: "manual" }]);
    return {
      nodes: [
        g.nodes[0]!,
        noDeIniciar([{ type: "start_automation", pointer_id, params: [] }]),
        g.nodes[1]!,
      ],
      edges: [
        { id: "e1", source: "n1", target: "acao-1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "acao-1", target: "n2", priority: 0, condition: { type: "always" } },
      ],
    } as FlowGraph;
  }
  const codigos = (r: ReturnType<typeof validateFlowForPublish>) =>
    r.ok ? [] : r.errors.map((e) => e.code);

  it("iniciar a si mesma é erro", () => {
    const r = validateFlowForPublish(grafoQueInicia(A), {
      surface: "automacao",
      automacao: { pointerId: A, existentes: new Set() },
    });
    expect(codigos(r)).toContain("automacao_iniciar_propria");
  });

  it("automação inexistente ou de outra organização (fora de `existentes`) é erro", () => {
    const r = validateFlowForPublish(grafoQueInicia(DE_FORA), {
      surface: "automacao",
      automacao: { pointerId: A, existentes: new Set([B]) },
    });
    expect(codigos(r)).toContain("automacao_iniciar_inexistente");
  });

  it("automação existente da organização passa", () => {
    const r = validateFlowForPublish(grafoQueInicia(B), {
      surface: "automacao",
      automacao: { pointerId: A, existentes: new Set([B]) },
    });
    expect(codigos(r)).not.toContain("automacao_iniciar_inexistente");
    expect(codigos(r)).not.toContain("automacao_iniciar_propria");
  });

  it("as referências do grafo listam as automações iniciadas", () => {
    expect(referenciasDoGrafo(grafoQueInicia(B)).automacoes).toEqual([B]);
  });
});

describe("o destino trabalha no MESMO negócio da origem (item 16)", () => {
  const LEAD_DA_ORIGEM = "50000000-0000-4000-8000-0000000000aa";
  it("o negócio da execução de origem vai para `_lead_id` do destino", async () => {
    const { admin, t } = criarBanco({
      enrollments: [
        { id: "e-a", organization_id: ORG, pointer_id: A, contact_id: CONTATO, status: "active", parent_enrollment_id: null },
      ],
    });
    const p = pedido({ id: "e-a", pointer_id: A }, [iniciarB]);
    p.fatos = { ...FATOS, negocio: { id: LEAD_DA_ORIGEM }, vars: { _lead_id: LEAD_DA_ORIGEM } } as unknown as FatosDaAutomacao;
    expect((await executor(admin).executar(p)).desfecho).toEqual({ ok: true });
    const nova = t.followup_enrollments!.find((e) => e.pointer_id === B)!;
    const vars = nova.vars as { _lead_id?: string; gatilho: Record<string, unknown> };
    expect(vars._lead_id).toBe(LEAD_DA_ORIGEM);
    expect(vars.gatilho).toMatchObject({ lead_id: LEAD_DA_ORIGEM, _lead_id: LEAD_DA_ORIGEM });
  });
  it("origem sem negócio: o destino não recebe `_lead_id`", async () => {
    const { admin, t } = criarBanco({
      enrollments: [
        { id: "e-a", organization_id: ORG, pointer_id: A, contact_id: CONTATO, status: "active", parent_enrollment_id: null },
      ],
    });
    await executor(admin).executar(pedido({ id: "e-a", pointer_id: A }, [iniciarB]));
    const nova = t.followup_enrollments!.find((e) => e.pointer_id === B)!;
    expect("_lead_id" in (nova.vars as Record<string, unknown>)).toBe(false);
  });
});

describe("frase do início para os gatilhos do lote 3 (item 17)", () => {
  const detalhe = (gatilho: string) =>
    descreveEvento(
      { id: "x", node_id: null, event_type: "automacao_iniciada", payload: { gatilho }, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
      "automacao",
    ).detalhe;
  it("cada gatilho novo diz o que começou, sem dado do contato", () => {
    expect(detalhe("message_received")).toBe("começou: mensagem recebida");
    expect(detalhe("tag_added")).toBe("começou: tag adicionada");
    expect(detalhe("appointment")).toBe("começou: agendamento");
    expect(detalhe("birthday")).toBe("começou: aniversário do contato");
    expect(detalhe("date_field")).toBe("começou: data de um campo do negócio");
    expect(detalhe("no_reply")).toBe("começou: contato sem resposta");
    expect(detalhe("case_opened")).toBe("começou: caso aberto na Central");
    expect(detalhe("lead_created")).toBe("um negócio foi criado");
    expect(detalhe("desconhecido")).toBeNull();
    expect(detalhe("constructor")).toBeNull();
  });
});
