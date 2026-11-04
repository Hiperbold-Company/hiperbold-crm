/**
 * Custo de IA do runtime nativo (S-13.08, `lib/ai/runtime/cost.ts`).
 *
 * Issue #1931: ids do OpenRouter com ponto/variante (`anthropic/claude-haiku-4.5`,
 * sufixos `:beta`/`:free`) não casam a tabela, e o `return 0` do caminho de
 * preço desconhecido contava um modelo caro como "de graça". Este teste prova
 * os três caminhos exigidos:
 *
 *   1. id canônico casa (custo volta a ser contado);
 *   2. ponto/variante normaliza para o id canônico (custo volta a ser contado);
 *   3. custo desconhecido NÃO volta zero — volta `null`, que quem soma no teto
 *      coalesce para 0 mas quem reporta distingue de "grátis" (contrato do seam
 *      `pricing.ts` e da legacy `precoDoCatalogo`).
 *
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): a mesma
 * leitura cacheada do catálogo `ai_models` é reaproveitada pelo resolvedor
 * único de `llm_calls` (`custoCentsComCatalogo`,
 * `lib/agent-engine/edge/llm/pricing.ts`, `lib/ai/cost.ts`):
 * `precoDoCatalogoOuNull` devolve `null` (nunca 0), sinaliza a falha de leitura
 * separadamente e normaliza o prefixo `provider/`; `criarResolvedorDeCatalogo`
 * aceita um carregador injetado (o `pg.Pool` do seam) com o mesmo cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeCostCents,
  criarResolvedorDeCatalogo,
  normalizarModeloId,
  precoDoCatalogoOuNull,
  _resetRuntimeCostCacheForTests,
} from "@/lib/ai/runtime/cost";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

/**
 * Catálogo controlado pelos testes de `precoDoCatalogoOuNull` (D-050). Os testes
 * de `computeCostCents` (#1931) trocam o admin inteiro com `mockReturnValue`.
 */
let catalogoLinhas: Array<{
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  deprecated_at?: string | null;
}> = [];
let catalogoDeveFalhar = false;
/** Item 11 da revisão: quando não nulo, o mock demora este tanto antes de responder. */
let catalogoAtrasoMs: number | null = null;

function adminDoCatalogoControlado() {
  return {
    from: (tabela: string) => {
      if (tabela !== "ai_models") throw new Error(`tabela inesperada no mock: ${tabela}`);
      return {
        select: async () => {
          if (catalogoAtrasoMs !== null) {
            await new Promise((resolve) => setTimeout(resolve, catalogoAtrasoMs!));
          }
          if (catalogoDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
          return { data: catalogoLinhas, error: null };
        },
      };
    },
  };
}

interface LinhaCatalogo {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

function adminComCatalogo(linhas: LinhaCatalogo[]) {
  return {
    from: () => ({
      select: () => Promise.resolve({ data: linhas, error: null }),
    }),
  };
}

const CATALOGO = [
  {
    provider: "anthropic",
    model_id: "claude-sonnet-5",
    input_price_per_million_cents: 200,
    output_price_per_million_cents: 1000,
  },
  {
    provider: "openrouter",
    model_id: "anthropic/claude-haiku-4-5",
    input_price_per_million_cents: 100,
    output_price_per_million_cents: 500,
  },
] as LinhaCatalogo[];

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(createAdminClient).mockImplementation(() => adminDoCatalogoControlado() as never);
  catalogoLinhas = [];
  catalogoDeveFalhar = false;
  catalogoAtrasoMs = null;
  _resetRuntimeCostCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizarModeloId — o id chega em formas que a tabela não conhece", () => {
  it("id canônico bare passa intacto", () => {
    expect(normalizarModeloId("claude-sonnet-5")).toEqual(["claude-sonnet-5"]);
  });

  it("ponto na versão vira hífen — a grafia do catálogo", () => {
    expect(normalizarModeloId("anthropic/claude-haiku-4.5")).toContain(
      "anthropic/claude-haiku-4-5",
    );
    expect(normalizarModeloId("claude-haiku-4.5")).toContain("claude-haiku-4-5");
  });

  it("sufixo de variante do roteador é recortado", () => {
    expect(normalizarModeloId("anthropic/claude-haiku-4.5:beta:free")).toContain(
      "anthropic/claude-haiku-4-5",
    );
    // Só o primeiro candidato (o id cru) carrega o sufixo.
    const c = normalizarModeloId("anthropic/claude-haiku-4.5:beta:free");
    expect(c.slice(1).some((x) => x.includes(":"))).toBe(false);
  });

  it("candidatos saem do mais específico para o generalista — o exato vence", () => {
    // A ordem importa: o match tenta o primeiro. O listado mais específico é o
    // id CRU, com o sufixo, como chegou — `<m>:free` tem linha própria.
    const c = normalizarModeloId("anthropic/claude-haiku-4.5:free");
    expect(c[0]).toBe("anthropic/claude-haiku-4.5:free");
    expect(c[1]).toBe("anthropic/claude-haiku-4.5");
    expect(c).toContain("claude-haiku-4-5");
  });
});

describe("computeCostCents — três caminhos da issue #1931", () => {
  it("1) id canônico casa e o custo volta a ser contado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 200 + 1000 centavos por milhão = 1200.
    expect(custo).toBe(1200);
  });

  it("2) ponto/variante normaliza para o canônico e o custo volta a ser contado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:beta",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // O catálogo tem openrouter:anthropic/claude-haiku-4-5 (100/500) — 600.
    expect(custo).toBe(600);
  });

  it("2b) o fallback acha o id no catálogo de outro provider que divide o preço", async () => {
    // O mesmo `anthropic/claude-haiku-4-5` servido pela Requesty e pela
    // OpenRouter divide o preço; sem o fallback por id o match ficaria à mercê
    // do nome do provider guardado.
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBe(600);
  });

  it("3) custo desconhecido NÃO volta zero — volta null, e não estoura o teto", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "desconhecido/modelo-x:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // null é o oposto de 0: quem soma no teto coalesce, mas não é "grátis".
    expect(custo).toBeNull();
    expect(custo).not.toBe(0);

    // E o budget guard do runtime: null não estoura o limite - o teto não leva
    // um número inventado que abortaria a chamada.
    const budget = 10;
    const estourou = custo !== null && custo > budget;
    expect(estourou).toBe(false);
  });

  it("catálogo que conhece o modelo mas não tem preço também é null, não 0", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct",
          input_price_per_million_cents: null,
          output_price_per_million_cents: null,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("4) `<m>:free` com linha própria custa 0, e `<m>` segue custando o pago", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct:free",
          input_price_per_million_cents: 0,
          output_price_per_million_cents: 0,
        },
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct",
          input_price_per_million_cents: 13,
          output_price_per_million_cents: 40,
        },
      ]) as never,
    );
    const uso = { provider: "openrouter", inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(await computeCostCents({ ...uso, model: "meta-llama/llama-3.3-70b-instruct:free" })).toBe(0);
    expect(await computeCostCents({ ...uso, model: "meta-llama/llama-3.3-70b-instruct" })).toBe(53);
  });

  it("5) `:free` sem linha própria NÃO herda o preço do pago — nem pelo fallback de outro provider", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4.5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("5b) `:free` com a linha paga SÓ sob outro provider também é null", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("6) 0/0 é grátis de verdade: custa 0, não null", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "google/gemma-3-27b-it",
          input_price_per_million_cents: 0,
          output_price_per_million_cents: 0,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "google/gemma-3-27b-it",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBe(0);
  });
});

describe("precoDoCatalogoOuNull, a leitura nova (D-050): null nunca é zero", () => {
  it("modelo fora do catálogo: preco null, falhou false", async () => {
    const resultado = await precoDoCatalogoOuNull("openai", "modelo-que-nao-existe");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("modelo no catálogo: devolve as duas tarifas exatas", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("normaliza o prefixo provider/ antes de bater no catálogo", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "openai/gpt-5.6-luna");
    expect(resultado.preco).toEqual({ inputCentsPerMillion: 20, outputCentsPerMillion: 120 });
  });

  it("leitura que falha: preco null, falhou true, nunca lança", async () => {
    catalogoDeveFalhar = true;
    await expect(precoDoCatalogoOuNull("openai", "gpt-5.6-luna")).resolves.toEqual({
      preco: null,
      falhou: true,
    });
  });

  // M2 (auditoria de segurança, 23/09/2026): preço PARCIALMENTE nulo no
  // catálogo não pode virar custo zero na metade que falta.
  it("preço de entrada nulo no catálogo: preco null inteiro, não {inputCentsPerMillion: 0, ...}", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: null, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("preço de saída nulo no catálogo: preco null inteiro", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: null },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });
});

/**
 * Item 10 da revisão (23/09/2026, regressão): o cron `sync-model-catalog`
 * (`lib/ai/catalogo/openrouter.ts`) grava modelo da OpenRouter como
 * `provider = 'openrouter'` e `model_id` COM o prefixo do fabricante
 * (`openai/gpt-5.6-luna`). A versão antiga só tentava `(provider, modelo sem
 * prefixo)`, e nunca achava essa linha. Os quatro formatos abaixo são os
 * citados no briefing da revisão.
 */
describe("precoDoCatalogoOuNull, ordem de busca da OpenRouter (item 10 da revisão)", () => {
  const PRECO_LUNA = { inputCentsPerMillion: 20, outputCentsPerMillion: 120 };

  it("openai + gpt-5.6-luna, com linha direta do provider (passo 1)", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openai + openai/gpt-5.6-luna, só com a linha da OpenRouter (passo 3: modelo como chegou)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "openai/gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openrouter + openai/gpt-5.6-luna, chave exata (passo 1)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openrouter", "openai/gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openai + gpt-5.6-luna SEM prefixo, só existe a linha prefixada da OpenRouter (passo 4: soma o prefixo)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("modelo em lugar nenhum do catálogo: preco null, falhou false", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "outro-fabricante/outro-modelo", input_price_per_million_cents: 1, output_price_per_million_cents: 1 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("qualquer provider com o mesmo model_id, comportamento antigo mantido por último (passo 5/6)", async () => {
    catalogoLinhas = [
      { provider: "fabricante-inesperado", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("linha depreciada (deprecated_at preenchido) não conta, mesmo model_id ativo em outro provider ganha", async () => {
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 999,
        output_price_per_million_cents: 999,
        deprecated_at: "2026-01-01T00:00:00Z",
      },
      { provider: "outro-fabricante", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });
});

/**
 * Item 11 da revisão (23/09/2026): prazo de 2s na leitura do catálogo, cache
 * velho como resposta de uma falha (quando existe) e backoff de 60s antes de
 * tentar de novo. Relógio falso: os prazos são medidos em tempo real, e um
 * teste com `setTimeout` de verdade seria lento e instável.
 */
describe("carregarCatalogo, prazo de 2s e backoff de 60s (item 11 da revisão)", () => {
  it("consulta que demora mais que 2s conta como falha; sem cache, falhou true", async () => {
    vi.useFakeTimers();
    catalogoAtrasoMs = 5000;
    const promessa = precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    await vi.advanceTimersByTimeAsync(2001);
    await expect(promessa).resolves.toEqual({ preco: null, falhou: true });
  });

  it("falha com cache velho disponível: falhou false, usa o preço do cache antigo", async () => {
    // Primeira leitura bem-sucedida, povoa o cache.
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const primeira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira.falhou).toBe(false);

    // TTL de 5 min vencido, nova tentativa falha: cache velho ainda serve o
    // mesmo preço, e falhou vira false porque o preço É conhecido.
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);
    catalogoDeveFalhar = true;
    const segunda = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(segunda).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("depois de uma falha, não tenta de novo por 60s mesmo com o catálogo já consertado", async () => {
    vi.useFakeTimers();
    catalogoDeveFalhar = true;
    const primeira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira).toEqual({ preco: null, falhou: true });

    // "Conserta" o catálogo, mas ainda dentro da janela de 60s de backoff.
    catalogoDeveFalhar = false;
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    vi.advanceTimersByTime(59_000);
    const segunda = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    // Ainda em backoff: nem tentou de novo, continua sem cache.
    expect(segunda).toEqual({ preco: null, falhou: true });

    vi.advanceTimersByTime(2_000); // total 61s: backoff passou.
    const terceira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(terceira).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });
});

/**
 * Revisão de 23/09/2026 (achado do invariante de preview,
 * `tests/invariants/autonomia-preview-core.test.ts`): a leitura do catálogo
 * era amarrada ao carregador HTTP (`createAdminClient`), e o resolvedor de
 * custo do `run-model-call.ts` precisa ler pelo `pg.Pool` (`db`) que já tem em
 * mãos, sem abrir `fetch` nenhum, o preview exige zero `fetch`. Este bloco
 * prova a FÁBRICA `criarResolvedorDeCatalogo` isolada do resolvedor padrão
 * (HTTP) deste arquivo: um carregador injetado qualquer (aqui, um objeto que
 * simula `db.query`) tem cache, prazo e ordem de busca IDÊNTICOS, e nunca
 * compartilha estado com o resolvedor HTTP acima.
 */
describe("criarResolvedorDeCatalogo, o carregador injetado (revisão de 23/09/2026)", () => {
  function poolFalso(linhas: typeof catalogoLinhas) {
    const query = vi.fn(async () => ({ rows: linhas }));
    return { query };
  }

  it("resolve pelo carregador injetado, sem tocar o carregador HTTP (createAdminClient)", async () => {
    const linhasDoDb = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const pool = poolFalso(linhasDoDb);
    const resolvedor = criarResolvedorDeCatalogo(async () => {
      const { rows } = await pool.query();
      return rows;
    });

    // Catálogo HTTP (mock de `@/lib/supabase/admin`) fica VAZIO de propósito:
    // se o resolvedor pelo `db` acidentalmente caísse para o HTTP, o preço
    // sumiria em vez de aparecer.
    catalogoLinhas = [];

    const resultado = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("cache do resolvedor injetado é ISOLADO do resolvedor HTTP padrão", async () => {
    // Povoa o cache do resolvedor HTTP com um preço.
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 999, output_price_per_million_cents: 999 },
    ];
    const doHttp = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(doHttp.preco).toEqual({ inputCentsPerMillion: 999, outputCentsPerMillion: 999 });

    // O resolvedor NOVO, com carregador próprio vazio, não enxerga o cache do
    // HTTP: cada `criarResolvedorDeCatalogo` tem seu próprio estado.
    const pool = poolFalso([]);
    const resolvedorNovo = criarResolvedorDeCatalogo(async () => {
      const { rows } = await pool.query();
      return rows;
    });
    const doNovo = await resolvedorNovo.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(doNovo).toEqual({ preco: null, falhou: false });
  });

  it("carregador que lança: falhou true, sem cache; com cache velho, serve o preço antigo", async () => {
    let deveLancar = false;
    const resolvedor = criarResolvedorDeCatalogo(async () => {
      if (deveLancar) throw new Error("db indisponível");
      return [
        { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
      ];
    });

    const primeira = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira.falhou).toBe(false);

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // TTL de 5 min vencido.
    deveLancar = true;
    const segunda = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    // Cache velho ainda serve o mesmo preço: falhou vira false.
    expect(segunda).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("_resetCacheParaTestes descarta só o cache DESTE resolvedor", async () => {
    const resolvedor = criarResolvedorDeCatalogo(async () => [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ]);
    await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    resolvedor._resetCacheParaTestes();

    // Depois do reset, uma nova leitura acontece (não serve cache velho); a
    // prova indireta é que o mapa devolvido reflete o carregador de novo, sem
    // erro nem resquício do backoff.
    const depois = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(depois).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });
});
