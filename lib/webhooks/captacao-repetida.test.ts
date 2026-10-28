import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import {
  ehCaptacaoRepetida,
  JANELA_DA_CAPTACAO_REPETIDA_MS,
  MENSAGEM_DA_CAPTACAO_REPETIDA,
  negocioDaCaptacaoRepetida,
} from "@/lib/webhooks/captacao-repetida";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const OUTRO_FUNIL = "22222222-2222-4222-8222-222222222222";
const AGORA = Date.parse("2026-10-27T12:00:00.000Z");
const haMinutos = (m: number) => new Date(AGORA - m * 60_000).toISOString();

describe("negocioDaCaptacaoRepetida — a regra do gatilho, sobre o que a rota lê", () => {
  it("negócio aberto no mesmo funil criado há menos de 10 min absorve o envio repetido", () => {
    const id = negocioDaCaptacaoRepetida(
      [{ id: "a", status: "open", pipeline_id: FUNIL, created_at: haMinutos(0.02) }],
      { pipelineId: FUNIL, agora: AGORA },
    );
    expect(id).toBe("a");
  });

  it("negócio aberto há mais de 10 min não é repetição (o caminho de antes decide)", () => {
    const id = negocioDaCaptacaoRepetida(
      [{ id: "a", status: "open", pipeline_id: FUNIL, created_at: haMinutos(10.5) }],
      { pipelineId: FUNIL, agora: AGORA },
    );
    expect(id).toBeNull();
  });

  it("negócio em outro funil não é repetição", () => {
    const id = negocioDaCaptacaoRepetida(
      [{ id: "a", status: "open", pipeline_id: OUTRO_FUNIL, created_at: haMinutos(1) }],
      { pipelineId: FUNIL, agora: AGORA },
    );
    expect(id).toBeNull();
  });

  it("negócio ganho ou perdido não é repetição", () => {
    const id = negocioDaCaptacaoRepetida(
      [
        { id: "a", status: "won", pipeline_id: FUNIL, created_at: haMinutos(1) },
        { id: "b", status: "lost", pipeline_id: FUNIL, created_at: haMinutos(1) },
      ],
      { pipelineId: FUNIL, agora: AGORA },
    );
    expect(id).toBeNull();
  });

  it("com dois dentro da janela, vence o criado primeiro (o que o gatilho deixou passar)", () => {
    const id = negocioDaCaptacaoRepetida(
      [
        { id: "z", status: "open", pipeline_id: FUNIL, created_at: haMinutos(1) },
        { id: "y", status: "open", pipeline_id: FUNIL, created_at: haMinutos(3) },
      ],
      { pipelineId: FUNIL, agora: AGORA },
    );
    expect(id).toBe("y");
  });
});

describe("ehCaptacaoRepetida — reconhece a recusa como createLeadHandler a repassa", () => {
  it("ApiError 500 com a mensagem do banco é repetição", () => {
    const erro = new ApiError(500, "internal_error", undefined, "req", MENSAGEM_DA_CAPTACAO_REPETIDA);
    expect(ehCaptacaoRepetida(erro)).toBe(true);
  });

  it("outra recusa (índice do external_id, teto do plano) não é", () => {
    expect(
      ehCaptacaoRepetida(new ApiError(500, "internal_error", undefined, "req", "uniq_crm_leads_org_source_external")),
    ).toBe(false);
    expect(ehCaptacaoRepetida(new ApiError(402, "plano_limite_atingido", undefined, "req", "limite"))).toBe(false);
    expect(ehCaptacaoRepetida(null)).toBe(false);
  });
});

describe("a janela do TypeScript é a mesma do banco", () => {
  const raiz = process.cwd();
  const minutos = JANELA_DA_CAPTACAO_REPETIDA_MS / 60_000;

  function corpoDaUltimaDefinicao(texto: string): string {
    const i = texto.lastIndexOf("create or replace function public.fn_crm_leads_captacao_repetida");
    expect(i).toBeGreaterThanOrEqual(0);
    return texto.slice(i, texto.indexOf("$$;", i));
  }

  it("baseline (última definição) e migration usam o mesmo intervalo", () => {
    const baseline = readFileSync(join(raiz, "supabase/baseline.sql"), "utf8");
    const arquivo = readdirSync(join(raiz, "supabase/migrations")).find((n) =>
      n.includes("_0977_captacao_repetida_nao_duplica_negocio"),
    );
    expect(arquivo).toBeDefined();
    const migration = readFileSync(join(raiz, "supabase/migrations", arquivo!), "utf8");
    for (const corpo of [corpoDaUltimaDefinicao(baseline), corpoDaUltimaDefinicao(migration)]) {
      expect(corpo).toContain(`interval '${minutos} minutes'`);
      expect(corpo).toContain(`message = '${MENSAGEM_DA_CAPTACAO_REPETIDA}'`);
    }
  });
});
