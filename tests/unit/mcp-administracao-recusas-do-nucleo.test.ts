/**
 * As recusas ESPERADAS do núcleo chegam ao MCP com o mesmo sentido da rota REST, não como 500.
 *
 *  - CNPJ de outra organização (`cnpj_em_uso`, erro 23505 do banco): conflito (409), com a frase
 *    legível — o integrador precisa saber que é o dado, não o servidor.
 *  - Campo marcado como Contato que uma regra ativa do gatilho por data lê (#2791): recusa de
 *    validação (422) que nomeia a regra; nada é gravado.
 *
 * O banco é um dublê das tabelas que o núcleo toca; o núcleo e a tool rodam de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));

import { allTools } from "@/lib/mcp/tools";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUNIL = "ffffffff-0000-4000-8000-00000000000f";

const tool = (nome: string) => allTools.find((t) => t.name === nome)!;

interface Respostas {
  /** O que o UPDATE de cada tabela devolve como erro. */
  erroNaGravacao?: Record<string, unknown>;
  linhas: Record<string, unknown>;
}

function ctxCom({ erroNaGravacao = {}, linhas }: Respostas) {
  const gravacoes: Array<{ tabela: string; patch: unknown }> = [];
  const from = (tabela: string) => {
    let patch: unknown;
    let gravando = false;
    const resposta = () => {
      if (gravando) {
        const erro = erroNaGravacao[tabela] ?? null;
        if (!erro) gravacoes.push({ tabela, patch });
        return { data: erro ? null : [{ id: "x" }], error: erro };
      }
      return { data: linhas[tabela] ?? null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      update: (p: unknown) => ((gravando = true), (patch = p), c),
      eq: () => c,
      is: () => c,
      maybeSingle: async () => resposta(),
      single: async () => resposta(),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, ko),
    };
    return c;
  };
  const ctx = {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: TOKEN, role: "admin" },
    apiTokenId: TOKEN,
    requestId: "req-1",
    supabase: { from, rpc: async () => ({ data: null, error: null }) },
  } as unknown as McpContext;
  return { ctx, gravacoes };
}

beforeEach(() => vi.clearAllMocks());

describe("crm_update_organization_settings — CNPJ de outra organização", () => {
  const atual = {
    display_name: "Loja",
    legal_name: "Loja Ltda",
    cnpj: null,
    country: null,
    timezone: "America/Sao_Paulo",
    locale: "pt-BR",
    currency: "BRL",
    media_retention_days: 90,
    media_retention_enforced: true,
    dpo_email: null,
    privacy_policy_url: null,
    onboarding_state: null,
    interface_settings: null,
  };

  it("responde 409 state_conflict com a frase legível, não 500", async () => {
    const { ctx, gravacoes } = ctxCom({
      linhas: { organizations: atual },
      erroNaGravacao: { organizations: { code: "23505", message: 'duplicate key value violates unique constraint "organizations_cnpj_key"' } },
    });
    await expect(tool("crm_update_organization_settings").handler({ cnpj: "12345678000190" }, ctx)).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
      message: "Este CNPJ já pertence a outra organização.",
    });
    expect(gravacoes).toEqual([]);
  });

  it("controle: sem colisão a gravação acontece e devolve a configuração", async () => {
    const { ctx, gravacoes } = ctxCom({ linhas: { organizations: atual } });
    await expect(tool("crm_update_organization_settings").handler({ cnpj: "12345678000190" }, ctx)).resolves.toBeTruthy();
    expect(gravacoes).toEqual([{ tabela: "organizations", patch: { cnpj: "12345678000190" } }]);
  });
});

describe("crm_update_pipeline_config — campo que vira Contato e o gatilho por data (#2791)", () => {
  const NASCIMENTO = { key: "nascimento", label: "Nascimento", type: "date" };
  const funil = { vocabulary: {}, settings: { fields: [NASCIMENTO] }, updated_at: "2026-11-04T00:00:00Z" };
  const regra = {
    name: "Parabéns",
    trigger_config: { pipeline_id: FUNIL, campo: "nascimento", dias: 3 },
  };

  it("responde 422 que nomeia a regra, não 500, e não grava", async () => {
    const { ctx, gravacoes } = ctxCom({ linhas: { crm_pipelines: funil, automation_rules: [regra] } });
    const pedido = { pipeline_id: FUNIL, config: { fields: [{ ...NASCIMENTO, escopo: "contato" }] } };
    const erro = await tool("crm_update_pipeline_config")
      .handler(pedido, ctx)
      .then(
        () => null,
        (e: unknown) => e as { status: number; code: string; message: string },
      );
    expect(erro).toMatchObject({ status: 422, code: "unprocessable_entity" });
    expect(erro?.message).toContain('"Parabéns"');
    expect(gravacoes).toEqual([]);
  });

  it("controle: sem regra que leia o campo, grava", async () => {
    const { ctx, gravacoes } = ctxCom({ linhas: { crm_pipelines: funil, automation_rules: [] } });
    const pedido = { pipeline_id: FUNIL, config: { fields: [{ ...NASCIMENTO, escopo: "contato" }] } };
    await tool("crm_update_pipeline_config").handler(pedido, ctx);
    expect(gravacoes.map((g) => g.tabela)).toEqual(["crm_pipelines"]);
  });
});

describe("crm_get_pipeline_config — lê o que a gravação aceita", () => {
  const ETAPA = "eeeeeeee-1111-4111-8111-111111111111";
  const ATALHO = { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" };

  it("devolve comanda_no_ganho, entrada_do_inbox, ocultar_encerrados_dias e atalhos gravados", async () => {
    const { ctx } = ctxCom({
      linhas: {
        crm_pipelines: {
          id: FUNIL,
          name: "Vendas",
          vocabulary: {},
          settings: {
            comanda_no_ganho: true,
            entrada_do_inbox: { ativa: true, stage_id: ETAPA },
            ocultar_encerrados_dias: 30,
            atalhos: [ATALHO],
          },
        },
      },
    });
    const lida = (await tool("crm_get_pipeline_config").handler({ pipeline_id: FUNIL }, ctx)) as {
      settings: Record<string, unknown>;
    };
    expect(lida.settings).toMatchObject({
      comanda_no_ganho: true,
      entrada_do_inbox: { ativa: true, stage_id: ETAPA },
      ocultar_encerrados_dias: 30,
      atalhos: [ATALHO],
    });
  });

  it("funil sem as chaves: desligado e vazio, como o quadro se comporta", async () => {
    const { ctx } = ctxCom({ linhas: { crm_pipelines: { id: FUNIL, name: "Vendas", vocabulary: {}, settings: {} } } });
    const lida = (await tool("crm_get_pipeline_config").handler({ pipeline_id: FUNIL }, ctx)) as {
      settings: Record<string, unknown>;
    };
    expect(lida.settings).toMatchObject({
      comanda_no_ganho: false,
      entrada_do_inbox: { ativa: false, stage_id: null },
      ocultar_encerrados_dias: 0,
      atalhos: [],
    });
  });
});

describe("crm_update_organization_settings — limpeza automática de mídia", () => {
  it("aceita media_retention_enforced e grava o interruptor", async () => {
    const { ctx, gravacoes } = ctxCom({ linhas: { organizations: { onboarding_state: null } } });
    await tool("crm_update_organization_settings").handler({ media_retention_enforced: false }, ctx);
    expect(gravacoes).toEqual([{ tabela: "organizations", patch: { media_retention_enforced: false } }]);
  });
});
