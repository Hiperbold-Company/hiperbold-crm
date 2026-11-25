/**
 * Motivos de perda da ORGANIZAÇÃO (migration 1021) e campos visíveis por funil (24/11/2026).
 *
 * O banco é um dublê em memória (tabelas `organizations`, `crm_pipelines`, `custom_field_definitions`
 * e as duas RPCs), para provar o que cada porta GRAVA e onde: a lista nova mora na organização, o
 * funil não ganha lista, e o audit sai uma vez só quando muda. O que o SQL faz (fusão, gatilho,
 * acréscimo) é provado em `tests/invariants/motivos-de-perda-da-organizacao.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const FUNIL = "ffffffff-0000-4000-8000-00000000000f";

const h = vi.hoisted(() => ({
  org: { settings: {} as Record<string, unknown> },
  funil: { settings: {} as Record<string, unknown>, vocabulary: {}, updated_at: "v1" },
  definicoes: [] as Array<{ key: string; entidade: string }>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  gravacoesDoFunil: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  funilExiste: true,
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: { action: string; metadata?: Record<string, unknown> }) => {
    h.audits.push(e);
  }),
}));

function banco() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      if (fn === "fn_atualizar_setting_da_organizacao") {
        const caminho = args.p_caminho as string[];
        h.org.settings = { ...h.org.settings, [caminho[0]!]: args.p_valor };
        return { data: 1, error: null };
      }
      if (fn === "fn_acrescentar_motivos_de_perda_da_organizacao") {
        const antes = Array.isArray(h.org.settings.lost_reasons) ? (h.org.settings.lost_reasons as unknown[]) : [];
        const rot = (x: unknown) => (typeof x === "string" ? x : (x as { label: string }).label).trim().toLowerCase();
        const lista = [...antes];
        for (const m of args.p_motivos as unknown[]) if (!lista.some((e) => rot(e) === rot(m))) lista.push(m);
        h.org.settings = { ...h.org.settings, lost_reasons: lista };
        return { data: { lista, mudou: lista.length !== antes.length, nao_couberam: [] }, error: null };
      }
      return { data: null, error: { message: `rpc desconhecida ${fn}` } };
    },
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      if (tabela === "organizations") {
        q.maybeSingle = async () => ({ data: { settings: h.org.settings }, error: null });
      } else if (tabela === "crm_pipelines") {
        q.maybeSingle = async () => ({
          data: h.funilExiste ? { id: FUNIL, name: "Vendas", organization_id: ORG, ...h.funil } : null,
          error: null,
        });
        q.update = (payload: Record<string, unknown>) => {
          h.gravacoesDoFunil.push(payload);
          h.funil = { ...h.funil, ...(payload as typeof h.funil), updated_at: "v2" };
          const w: Record<string, unknown> = {};
          w.eq = () => w;
          w.select = async () => ({ data: [{ id: FUNIL }], error: null });
          return w;
        };
      } else if (tabela === "custom_field_definitions") {
        q.then = (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: h.definicoes, count: h.definicoes.length, error: null }).then(resolve);
      }
      return q;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { camposExigidosNoDestino, settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { camposDoFunilVisiveis } from "@/lib/leads/campos-do-funil";
import { recusaDeMotivoForaDoVocabulario } from "@/lib/leads/motivo-da-perda";
import {
  listaDoTexto,
  salvarMotivosDaOrganizacao,
  settingsComMotivosDaOrganizacao,
} from "@/lib/leads/motivos-da-organizacao";
import { categoriaDoMotivo, motivosDaCategoria, motivosDoFunil, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";
import { aplicarConfiguracaoDoFunil, CAMPOS_OBRIGATORIOS_ESCONDIDOS, CAMPOS_VISIVEIS_INVALIDOS } from "@/lib/pipelines/configuracao-do-funil";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

const db = () => banco() as unknown as SupabaseClient;

beforeEach(() => {
  h.org = { settings: {} };
  h.funil = { settings: {}, vocabulary: {}, updated_at: "v1" };
  h.definicoes = [];
  h.rpcs = [];
  h.gravacoesDoFunil = [];
  h.audits = [];
  h.funilExiste = true;
});

describe("o leitor usa a lista da ORGANIZAÇÃO", () => {
  it("o settings efetivo oferece a lista da organização e guarda a do funil só para aceitar", async () => {
    h.org.settings = { lost_reasons: ["Da empresa", { label: "Preço", categoria: "Nós" }] };
    h.funil.settings = { lost_reasons: ["Só do funil"] };
    const efetivo = await settingsDoFunil(db(), FUNIL);
    expect(motivosDoFunil(efetivo)).toEqual(["Da empresa", "Preço"]);
    expect(opcoesDeMotivoDePerda(motivosDoFunil(efetivo)).map((o) => o.valor)).toEqual(["Da empresa", "Preço", "other"]);
  });

  it("organização sem a chave segue no legado do funil", async () => {
    h.funil.settings = { lost_reasons: ["Só do funil"] };
    expect(motivosDoFunil(await settingsDoFunil(db(), FUNIL))).toEqual(["Só do funil"]);
  });

  it("a aceitação espelha o gatilho: organização ∪ legado do funil ∪ canônico (inclusive other); o resto é recusado", () => {
    const efetivo = settingsComMotivosDaOrganizacao({ lost_reasons: ["Só do funil"] }, ["Da empresa"]);
    for (const motivo of ["Da empresa", "Só do funil", "other", "price"]) {
      expect(recusaDeMotivoForaDoVocabulario({ motivo, settingsDoFunil: efetivo }), motivo).toBeNull();
    }
    expect(recusaDeMotivoForaDoVocabulario({ motivo: "Inventado", settingsDoFunil: efetivo })?.codigo).toBe(
      "lost_reason_invalid",
    );
  });

  it("a categoria vem da organização, sem diferenciar maiúsculas e espaços, e alcança a grafia legada", () => {
    const efetivo = settingsComMotivosDaOrganizacao({ lost_reasons: ["preço  ALTO "] }, [
      { label: "Preço alto", categoria: "Nós" },
    ]);
    expect(categoriaDoMotivo("preço  ALTO ", efetivo)).toBe("Nós");
    expect(motivosDaCategoria([{ settings: efetivo }], "Nós")).toEqual(
      expect.arrayContaining(["Preço alto", "preço  ALTO "]),
    );
  });
});

describe("a tela da empresa grava a lista da organização", () => {
  it("substitui só a chave lost_reasons, sem repetir rótulo, e audita uma vez", async () => {
    h.org.settings = { outra_chave: 1, lost_reasons: ["Velho"] };
    const r = await salvarMotivosDaOrganizacao(db(), {
      organizationId: ORG,
      lista: listaDoTexto("Preço, preço , Prazo", { Prazo: "Cliente" }),
      autor: { actorUserId: "u" },
    });
    expect(r).toEqual({ ok: true, lista: ["Preço", { label: "Prazo", categoria: "Cliente" }], mudou: true });
    expect(h.org.settings).toEqual({ outra_chave: 1, lost_reasons: ["Preço", { label: "Prazo", categoria: "Cliente" }] });
    expect(h.audits.map((a) => a.action)).toEqual(["organization.lost_reasons_updated"]);
  });

  it("salvar a mesma lista não grava nem audita", async () => {
    h.org.settings = { lost_reasons: ["Preço"] };
    const r = await salvarMotivosDaOrganizacao(db(), { organizationId: ORG, lista: ["Preço"], autor: {} });
    expect(r).toMatchObject({ ok: true, mudou: false });
    expect(h.rpcs).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("recusa mais de 50 e rótulo acima de 80 (a régua do funil)", async () => {
    const muitos = Array.from({ length: 51 }, (_, i) => `M${i}`);
    expect((await salvarMotivosDaOrganizacao(db(), { organizationId: ORG, lista: muitos, autor: {} })).ok).toBe(false);
    expect((await salvarMotivosDaOrganizacao(db(), { organizationId: ORG, lista: ["x".repeat(81)], autor: {} })).ok).toBe(
      false,
    );
  });
});

describe("a configuração do funil (API/MCP/action) escreve na organização", () => {
  it("lost_reasons acrescenta à lista da organização, não grava no funil e responde com a lista da organização", async () => {
    h.org.settings = { lost_reasons: ["Antigo da empresa"] };
    h.funil.settings = { lost_reasons: ["Legado"] };
    const r = await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { lost_reasons: ["Novo"] },
      autor: { actorUserId: "u" },
    });
    expect(r.ok).toBe(true);
    expect(h.org.settings.lost_reasons).toEqual(["Antigo da empresa", "Novo"]);
    expect(h.gravacoesDoFunil.every((g) => (g.settings as Record<string, unknown>).lost_reasons?.toString() === "Legado")).toBe(true);
    expect(r.ok && r.dados.settings.lost_reasons).toEqual(["Antigo da empresa", "Novo"]);
    expect(h.audits.filter((a) => a.action === "organization.lost_reasons_updated")).toHaveLength(1);
  });

  it("funil inexistente: not_found e a lista da empresa não muda", async () => {
    h.org.settings = { lost_reasons: ["Antigo da empresa"] };
    h.funilExiste = false;
    const r = await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { lost_reasons: ["Novo"] },
      autor: { actorUserId: "u" },
    });
    expect(!r.ok && r.error).toBe("not_found");
    expect(h.org.settings.lost_reasons).toEqual(["Antigo da empresa"]);
    expect(h.audits.filter((a) => a.action === "organization.lost_reasons_updated")).toEqual([]);
  });

  it("pedido recusado pelos campos visíveis não acrescenta motivo à empresa", async () => {
    h.org.settings = { lost_reasons: ["Antigo da empresa"] };
    h.definicoes = [{ key: "origem", entidade: "negocio" }];
    const r = await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { lost_reasons: ["Novo"], campos_visiveis: ["inexistente"] },
      autor: {},
    });
    expect(r.ok).toBe(false);
    expect(h.org.settings.lost_reasons).toEqual(["Antigo da empresa"]);
    expect(h.gravacoesDoFunil).toEqual([]);
  });

  it("acrescentar o que já existe não audita a lista da organização", async () => {
    h.org.settings = { lost_reasons: ["Novo"] };
    await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { lost_reasons: ["novo"] },
      autor: {},
    });
    expect(h.audits.filter((a) => a.action === "organization.lost_reasons_updated")).toEqual([]);
  });
});

describe("campos_visiveis: o funil escolhe quais campos do negócio mostra", () => {
  const campos = [
    { key: "origem", label: "Origem", type: "text" },
    { key: "valor", label: "Valor", type: "number" },
    { key: "cpf", label: "CPF", type: "text", escopo: "contato" },
  ];

  it("ausente = todos; lista = só esses do negócio (contato passa sempre)", () => {
    expect(camposDoFunilVisiveis({ fields: campos }).map((c) => c.key)).toEqual(["origem", "valor", "cpf"]);
    expect(camposDoFunilVisiveis({ fields: campos, campos_visiveis: ["valor"] }).map((c) => c.key)).toEqual([
      "valor",
      "cpf",
    ]);
  });

  it("campo escondido não é exigido na etapa", () => {
    const settings = {
      fields: [{ ...campos[0], obrigatorio_em: { ao_ganhar: true } }, { ...campos[1], obrigatorio_em: { ao_ganhar: true } }],
      campos_visiveis: ["valor"],
    };
    expect(camposExigidosNoDestino(settings, { desfecho: "won" }).map((c) => c.key)).toEqual(["valor"]);
  });

  it("Zod: aceita null e lista de chaves; recusa chave com formato inválido", () => {
    expect(pipelineConfigPatchSchema.safeParse({ campos_visiveis: null }).success).toBe(true);
    expect(pipelineConfigPatchSchema.safeParse({ campos_visiveis: ["origem"] }).success).toBe(true);
    expect(pipelineConfigPatchSchema.safeParse({ campos_visiveis: ["não é chave!"] }).success).toBe(false);
  });

  it("recusa chave que não é campo de NEGÓCIO da organização (inexistente ou de contato)", async () => {
    h.definicoes = [
      { key: "origem", entidade: "negocio" },
      { key: "cpf", entidade: "contato" },
    ];
    for (const chave of ["inexistente", "cpf"]) {
      const r = await aplicarConfiguracaoDoFunil(db(), {
        organizationId: ORG,
        pipelineId: FUNIL,
        patch: { campos_visiveis: [chave] },
        autor: {},
      });
      expect(r.ok, chave).toBe(false);
      expect(!r.ok && (r.details as Record<string, unknown>)[CAMPOS_VISIVEIS_INVALIDOS]).toEqual([chave]);
    }
    expect(h.gravacoesDoFunil).toEqual([]);
  });

  it("recusa esconder um campo obrigatório no funil", async () => {
    h.definicoes = [
      { key: "origem", entidade: "negocio" },
      { key: "valor", entidade: "negocio" },
    ];
    h.funil.settings = { campos_obrigatorios: { origem: { ao_ganhar: true } } };
    const r = await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { campos_visiveis: ["valor"] },
      autor: {},
    });
    expect(!r.ok && (r.details as Record<string, unknown>)[CAMPOS_OBRIGATORIOS_ESCONDIDOS]).toEqual(["origem"]);
    expect(h.gravacoesDoFunil).toEqual([]);
  });

  it("grava a lista, e null volta a mostrar todos — sem tocar nos valores dos negócios", async () => {
    h.definicoes = [{ key: "origem", entidade: "negocio" }];
    const r = await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { campos_visiveis: ["origem"] },
      autor: {},
    });
    expect(r.ok && r.dados.settings.campos_visiveis).toEqual(["origem"]);
    await aplicarConfiguracaoDoFunil(db(), {
      organizationId: ORG,
      pipelineId: FUNIL,
      patch: { campos_visiveis: null },
      autor: {},
    });
    expect("campos_visiveis" in h.funil.settings).toBe(false);
  });
});
