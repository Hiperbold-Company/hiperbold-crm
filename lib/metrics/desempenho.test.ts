import { describe, expect, it } from "vitest";

import {
  DIAS_MAXIMOS,
  filtroDaQuery,
  filtrosParaUrl,
  formatarDuracao,
  janelaDoAtalho,
  janelaDosFiltros,
  lerFiltrosDaUrl,
  progressoNaEtapa,
  queryDaApi,
  resolverJanela,
  variacaoPercentual,
} from "./desempenho";

const UUID = "d9810981-5555-4000-8000-000000000001";
const sp = (s: string) => new URLSearchParams(s);

describe("resolverJanela", () => {
  const agora = new Date("2026-07-31T12:00:00Z");
  it("sem nada: últimos 30 dias até agora", () => {
    const j = resolverJanela({}, agora);
    expect(j.ok && j.to.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(j.ok && j.from.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });
  it("recusa janela invertida e mais longa que o teto", () => {
    expect(resolverJanela({ from: "2026-07-02T00:00:00Z", to: "2026-07-01T00:00:00Z" })).toEqual({ ok: false, motivo: "ordem" });
    const de = new Date(agora.getTime() - (DIAS_MAXIMOS + 1) * 86_400_000).toISOString();
    expect(resolverJanela({ from: de, to: agora.toISOString() })).toEqual({ ok: false, motivo: "longa" });
  });
});

describe("filtroDaQuery", () => {
  it("aceita funil e atendente uuid; recusa texto que não é uuid nem data", () => {
    expect(filtroDaQuery.safeParse({ pipeline_id: UUID, owner_user_id: UUID }).success).toBe(true);
    expect(filtroDaQuery.safeParse({ pipeline_id: "x' or 1=1" }).success).toBe(false);
    expect(filtroDaQuery.safeParse({ from: "ontem" }).success).toBe(false);
  });
});

describe("filtro na URL", () => {
  it("padrão quando a URL está vazia ou estranha", () => {
    expect(lerFiltrosDaUrl(sp("aba=xpto&periodo=semana&funil=nao-uuid"))).toEqual({
      aba: "negocios", atalho: "30d", de: null, ate: null, funil: null, atendente: null,
    });
  });
  it("ida e volta preserva aba, período personalizado, funil e atendente", () => {
    const url = `aba=origens&periodo=personalizado&de=2026-07-01&ate=2026-07-10&funil=${UUID}&atendente=${UUID}`;
    const f = lerFiltrosDaUrl(sp(url));
    expect(lerFiltrosDaUrl(sp(filtrosParaUrl(f).slice(1)))).toEqual(f);
    expect(filtrosParaUrl(lerFiltrosDaUrl(sp("")))).toBe("");
  });
  it("personalizado com de > até volta ao padrão", () => {
    expect(lerFiltrosDaUrl(sp("periodo=personalizado&de=2026-07-10&ate=2026-07-01")).atalho).toBe("30d");
  });
  it("personalizado: o dia final entra inteiro (to = dia seguinte)", () => {
    const f = lerFiltrosDaUrl(sp("periodo=personalizado&de=2026-07-01&ate=2026-07-10"));
    const { from, to } = janelaDosFiltros(f);
    expect([from.getDate(), to.getMonth(), to.getDate()]).toEqual([1, 6, 11]);
  });
  it("a query da API leva janela, funil e atendente", () => {
    const f = lerFiltrosDaUrl(sp(`funil=${UUID}&atendente=${UUID}`));
    const q = new URLSearchParams(queryDaApi(f));
    expect(q.get("pipeline_id")).toBe(UUID);
    expect(q.get("owner_user_id")).toBe(UUID);
    expect(new Date(q.get("from")!).getTime()).toBeLessThan(new Date(q.get("to")!).getTime());
  });
});

describe("janelaDoAtalho", () => {
  const agora = new Date(2026, 6, 15, 10, 30);
  it("hoje vai da meia-noite à meia-noite seguinte", () => {
    const j = janelaDoAtalho("hoje", agora);
    expect([j.from.getDate(), j.from.getHours(), j.to.getDate()]).toEqual([15, 0, 16]);
  });
  it("mês passado é o mês anterior inteiro", () => {
    const j = janelaDoAtalho("mes_anterior", agora);
    expect([j.from.getMonth(), j.from.getDate(), j.to.getMonth(), j.to.getDate()]).toEqual([5, 1, 6, 1]);
  });
  it("7 dias incluem hoje", () => {
    const j = janelaDoAtalho("7d", agora);
    expect([j.from.getDate(), j.to.getDate()]).toEqual([9, 16]);
  });
});

describe("contas pequenas", () => {
  it("variação sem base é nula", () => {
    expect(variacaoPercentual(5, 0)).toBeNull();
    expect(variacaoPercentual(3, 2)).toBe(50);
    expect(variacaoPercentual(1, 3)).toBe(-66.7);
  });
  it("duração legível", () => {
    expect(formatarDuracao(null)).toBe("—");
    expect(formatarDuracao(45)).toBe("45s");
    expect(formatarDuracao(90)).toBe("1min");
    expect(formatarDuracao(3 * 3600 + 300)).toBe("3h 5min");
    expect(formatarDuracao(26 * 3600)).toBe("1d 2h");
  });
  it("progresso na etapa", () => {
    expect(progressoNaEtapa("b", ["a", "b", "c", "d"])).toBe(0.5);
    expect(progressoNaEtapa("z", ["a"])).toBeNull();
  });
});
