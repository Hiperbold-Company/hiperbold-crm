/**
 * A lista de modelos do classificador só pode oferecer caminho que TEM como
 * funcionar. Oferecer o catálogo inteiro produz o pior desfecho: o operador
 * escolhe um modelo de um provedor sem chave, salva, e a tela passa a dizer
 * "nenhuma intenção casou" — uma frase sobre o texto dele, não sobre a chave que
 * falta.
 */
import { describe, expect, it, vi } from "vitest";

import { listClassifierModels } from "@/lib/ai/classifier-models";

type Linha = Record<string, unknown>;

/** Dublê encadeável do PostgREST: devolve `creds` para a 1ª tabela, `models` para a 2ª. */
function db(opts: {
  creds?: { data?: Linha[]; error?: unknown };
  models?: { data?: Linha[]; error?: unknown };
  onIn?: (valores: unknown) => void;
}) {
  return {
    from(tabela: string) {
      const alvo = tabela === "ai_provider_credentials" ? opts.creds : opts.models;
      const resultado = { data: alvo?.data ?? [], error: alvo?.error ?? null };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "is", "order"]) {
        builder[m] = () => builder;
      }
      builder["in"] = (_col: string, valores: unknown) => {
        opts.onIn?.(valores);
        return builder;
      };
      // Encadeamento termina num thenable — é assim que o client resolve.
      builder["then"] = (r: (v: unknown) => unknown) => Promise.resolve(resultado).then(r);
      return builder;
    },
  } as never;
}

const SEM_PLATAFORMA = { openrouter: false, modelosDaInstalacao: ["openai/gpt-6-luna"] };
const COM_PLATAFORMA = { openrouter: true, modelosDaInstalacao: ["openai/gpt-6-luna"] };

describe("listClassifierModels", () => {
  it("oferece apenas provedores com credencial da organização ativa e validada", async () => {
    let pedidos: unknown = null;
    const out = await listClassifierModels(
      db({
        creds: { data: [{ provider: "openai" }] },
        models: { data: [{ provider: "openai", model_id: "gpt-5-mini", display_name: "GPT-5 mini" }] },
        onIn: (v) => (pedidos = v),
      }),
      "org1",
      SEM_PLATAFORMA,
    );
    expect(pedidos).toEqual(["openai"]);
    expect(out).toEqual([
      { provider: "openai", model_id: "gpt-5-mini", display_name: "GPT-5 mini", origem: "org" },
    ]);
  });

  it("a chave da instalação conta — e é só a OpenRouter, com os modelos do plano", async () => {
    let pedidos: unknown = null;
    const out = await listClassifierModels(
      db({
        creds: { data: [] },
        models: {
          data: [
            { provider: "openrouter", model_id: "openai/gpt-6-luna", display_name: "Luna" },
            { provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6", display_name: "Sonnet" },
          ],
        },
        onIn: (v) => (pedidos = v),
      }),
      "org1",
      COM_PLATAFORMA,
    );
    expect(pedidos).toEqual(["openrouter"]);
    // Sonnet ficaria escolhível e o freio rodaria Luna no lugar: fora da lista.
    expect(out.map((m) => m.model_id)).toEqual(["openai/gpt-6-luna"]);
    expect(out[0]?.origem).toBe("plataforma");
  });

  it("credencial OpenRouter da organização não sofre o filtro do plano", async () => {
    const out = await listClassifierModels(
      db({
        creds: { data: [{ provider: "openrouter" }] },
        models: { data: [{ provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6", display_name: "Sonnet" }] },
      }),
      "org1",
      COM_PLATAFORMA,
    );
    expect(out.map((m) => [m.model_id, m.origem])).toEqual([["anthropic/claude-sonnet-4-6", "org"]]);
  });

  it("credencial da organização vence a chave da instalação na marcação de origem", async () => {
    const out = await listClassifierModels(
      db({
        creds: { data: [{ provider: "anthropic" }] },
        models: { data: [{ provider: "anthropic", model_id: "claude-haiku-4-5", display_name: "Haiku" }] },
      }),
      "org1",
      COM_PLATAFORMA,
    );
    expect(out[0]?.origem).toBe("org");
  });

  it("a chave do Jev (que não conversa) não abre o catálogo dele como classificador", async () => {
    let pedidos: unknown = null;
    const out = await listClassifierModels(
      db({
        creds: { data: [{ provider: "typesafe" }, { provider: "openai" }] },
        models: { data: [{ provider: "openai", model_id: "gpt-5-mini", display_name: "GPT-5 mini" }] },
        onIn: (v) => (pedidos = v),
      }),
      "org1",
      SEM_PLATAFORMA,
    );
    expect(pedidos).toEqual(["openai"]);
    expect(out.map((m) => m.provider)).toEqual(["openai"]);
  });

  it("sem credencial nenhuma devolve lista vazia — e NÃO consulta o catálogo", async () => {
    const consultouCatalogo = vi.fn();
    const out = await listClassifierModels(
      db({ creds: { data: [] }, models: { data: [] }, onIn: consultouCatalogo }),
      "org1",
      SEM_PLATAFORMA,
    );
    expect(out).toEqual([]);
    expect(consultouCatalogo).not.toHaveBeenCalled();
  });

  it("falha da consulta SOBE — lista vazia seria lida como 'não dá para escolher modelo'", async () => {
    await expect(
      listClassifierModels(
        db({ creds: { error: { message: "boom" } } }),
        "org1",
        SEM_PLATAFORMA,
      ),
    ).rejects.toThrow(/classifier_models_credentials_failed/);
  });

  it("modelo sem display_name cai no id — nunca vira opção em branco", async () => {
    const out = await listClassifierModels(
      db({
        creds: { data: [{ provider: "openai" }] },
        models: { data: [{ provider: "openai", model_id: "gpt-5-mini", display_name: null }] },
      }),
      "org1",
      SEM_PLATAFORMA,
    );
    expect(out[0]?.display_name).toBe("gpt-5-mini");
  });
});
