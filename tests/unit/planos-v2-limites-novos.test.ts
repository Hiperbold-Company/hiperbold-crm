import { describe, expect, it } from "vitest";

import { estadoInicialDoAjuste, ajusteDoFormulario } from "@/lib/billing/planos/formulario-de-ajuste";
import {
  CHAVES_DE_LIMITE,
  esquemaDoAjusteDeLimites,
  esquemaDoPlanoDeLimites,
  limiteDaChave,
  normalizarLimites,
  recursoIncluidoNosLimites,
} from "@/lib/billing/planos/limites";
import { linhasDosRecursosDoPlano } from "@/lib/billing/planos/linhas-da-tela-de-plano";

const SETE = {
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 3,
  tokens_ia_mes: 3000000,
};
const SEIS_PRO = {
  agentes_ia: 1,
  automacoes: 10,
  mcp_req_min: 0,
  acesso_api: 0,
  automacao_comentario_instagram: 0,
  fonte_dados_req_min: 60,
};

describe("esquemaDoPlanoDeLimites: 7 ou 13 chaves, sempre devolve 13", () => {
  it("plano de 7 chaves (v1) vira 13 com as novas null", () => {
    const r = esquemaDoPlanoDeLimites.parse(SETE);
    expect(Object.keys(r)).toHaveLength(13);
    expect(r.agentes_ia).toBeNull();
    expect(r.acesso_api).toBeNull();
    expect(r.funis).toBe(5);
  });

  it("plano de 13 chaves passa inteiro", () => {
    expect(esquemaDoPlanoDeLimites.parse({ ...SETE, ...SEIS_PRO })).toEqual({ ...SETE, ...SEIS_PRO });
  });

  it("meio-termo, chave estranha e liga/desliga fora de 0/1 são recusados", () => {
    expect(esquemaDoPlanoDeLimites.safeParse({ ...SETE, agentes_ia: 1 }).success).toBe(false);
    expect(esquemaDoPlanoDeLimites.safeParse({ ...SETE, ...SEIS_PRO, x: 1 }).success).toBe(false);
    expect(esquemaDoPlanoDeLimites.safeParse({ ...SETE, ...SEIS_PRO, acesso_api: 2 }).success).toBe(false);
  });

  it("ajuste aceita chave nova sozinha e recusa liga/desliga 2", () => {
    expect(esquemaDoAjusteDeLimites.safeParse({ mcp_req_min: 5 }).success).toBe(true);
    expect(esquemaDoAjusteDeLimites.safeParse({ automacao_comentario_instagram: 2 }).success).toBe(false);
  });
});

describe("limiteDaChave e recursoIncluidoNosLimites", () => {
  it("chave ausente vale null (sem limite) e o recurso fica incluso", () => {
    expect(limiteDaChave(SETE, "agentes_ia")).toBeNull();
    expect(recursoIncluidoNosLimites(SETE, "mcp")).toBe(true);
    expect(recursoIncluidoNosLimites(SETE, "api")).toBe(true);
  });

  it("0 = não incluso; positivo e null = incluso", () => {
    const pro = normalizarLimites({ ...SETE, ...SEIS_PRO });
    expect(recursoIncluidoNosLimites(pro, "mcp")).toBe(false);
    expect(recursoIncluidoNosLimites(pro, "api")).toBe(false);
    expect(recursoIncluidoNosLimites(pro, "comentario_instagram")).toBe(false);
    expect(recursoIncluidoNosLimites({ ...pro, mcp_req_min: 30 }, "mcp")).toBe(true);
    expect(recursoIncluidoNosLimites({ ...pro, acesso_api: null }, "api")).toBe(true);
    expect(limiteDaChave(pro, "fonte_dados_req_min")).toBe(60);
  });
});

describe("linhasDosRecursosDoPlano", () => {
  it("Pro v2: agentes até 1, MCP/API/comentário não inclusos, fonte 60 req/min", () => {
    const linhas = linhasDosRecursosDoPlano(normalizarLimites({ ...SETE, ...SEIS_PRO }), false);
    expect(Object.fromEntries(linhas.map((l) => [l.chave, l.valor]))).toEqual({
      agentes_ia: { tipo: "ate", quantidade: 1 },
      automacoes: { tipo: "ate", quantidade: 10 },
      mcp_req_min: { tipo: "nao_incluso" },
      acesso_api: { tipo: "nao_incluso" },
      automacao_comentario_instagram: { tipo: "nao_incluso" },
      fonte_dados_req_min: { tipo: "por_minuto", quantidade: 60 },
    });
  });

  it("plano v1 (chaves novas null): tudo sem limite ou incluso", () => {
    const linhas = linhasDosRecursosDoPlano(normalizarLimites(SETE), false);
    expect(linhas.map((l) => l.valor.tipo)).toEqual([
      "sem_limite", "sem_limite", "sem_limite", "incluso", "incluso", "sem_limite",
    ]);
  });

  it("MCP com valor vira N req/min; leitura falhada é não sei em tudo", () => {
    const max = normalizarLimites({ ...SETE, ...SEIS_PRO, mcp_req_min: 30, acesso_api: 1 });
    const linhas = linhasDosRecursosDoPlano(max, false);
    expect(linhas.find((l) => l.chave === "mcp_req_min")?.valor).toEqual({ tipo: "por_minuto", quantidade: 30 });
    expect(linhas.find((l) => l.chave === "acesso_api")?.valor).toEqual({ tipo: "incluso" });
    expect(linhasDosRecursosDoPlano(max, true).every((l) => l.valor.tipo === "nao_sei")).toBe(true);
  });
});

describe("formulário de ajuste com as chaves novas", () => {
  it("cobre as 13 chaves e recusa 2 em liga/desliga", () => {
    const estado = estadoInicialDoAjuste({ mcp_req_min: 5 });
    expect(Object.keys(estado)).toHaveLength(CHAVES_DE_LIMITE.length);
    expect(estado.mcp_req_min).toEqual({ modo: "valor", valor: "5" });
    const r = ajusteDoFormulario({ ...estado, acesso_api: { modo: "valor", valor: "2" } });
    expect(r).toMatchObject({ ok: false, chave: "acesso_api" });
    const ok = ajusteDoFormulario({ ...estado, acesso_api: { modo: "valor", valor: "1" } });
    expect(ok).toEqual({ ok: true, limites: { mcp_req_min: 5, acesso_api: 1 } });
  });
});
