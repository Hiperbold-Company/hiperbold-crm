import { describe, expect, it } from "vitest";

import { primeirosPassos, type DadosDosPrimeirosPassos } from "./primeiros-passos";

const TUDO_PENDENTE: DadosDosPrimeirosPassos = {
  compraLigada: true,
  planoAtivo: false,
  emailVerificado: false,
  oQueFaz: null,
  fuso: "America/Sao_Paulo",
  whatsappConectado: false,
  agentePublicado: false,
  marcaPorOrganizacaoLigada: true,
  logoDefinido: false,
  followupAtivo: false,
  membrosAtivos: 1,
};

const TUDO_FEITO: DadosDosPrimeirosPassos = {
  ...TUDO_PENDENTE,
  planoAtivo: true,
  emailVerificado: true,
  oQueFaz: "clínica odontológica",
  whatsappConectado: true,
  agentePublicado: true,
  logoDefinido: true,
  followupAtivo: true,
  membrosAtivos: 3,
};

const feito = (dados: DadosDosPrimeirosPassos) =>
  Object.fromEntries(primeirosPassos(dados).passos.map((p) => [p.id, p.feito]));

describe("primeirosPassos", () => {
  it("tudo pendente: 0 de 4 obrigatórios, nenhum item feito", () => {
    const r = primeirosPassos(TUDO_PENDENTE);
    expect(r.contagem).toEqual({
      obrigatoriosTotal: 4,
      obrigatoriosFeitos: 0,
      obrigatoriosFaltando: 4,
      opcionaisTotal: 4,
      opcionaisFeitos: 0,
    });
    expect(r.passos.every((p) => !p.feito)).toBe(true);
  });

  it("tudo feito: os obrigatórios não faltam e todo item está feito", () => {
    const r = primeirosPassos(TUDO_FEITO);
    expect(r.contagem.obrigatoriosFaltando).toBe(0);
    expect(r.contagem.obrigatoriosFeitos).toBe(4);
    expect(r.contagem.opcionaisFeitos).toBe(4);
    expect(r.passos.every((p) => p.feito)).toBe(true);
  });

  it("obrigatórios vêm antes dos opcionais, na ordem em que se faz", () => {
    const ids = primeirosPassos(TUDO_PENDENTE).passos.map((p) => `${p.tipo}:${p.id}`);
    expect(ids).toEqual([
      "obrigatorio:plano",
      "obrigatorio:email",
      "obrigatorio:perfil",
      "obrigatorio:whatsapp",
      "opcional:agente",
      "opcional:logo",
      "opcional:followup",
      "opcional:equipe",
    ]);
  });

  it.each([
    ["plano", { planoAtivo: true }],
    ["email", { emailVerificado: true }],
    ["perfil", { oQueFaz: "vendo roupa" }],
    ["whatsapp", { whatsappConectado: true }],
    ["agente", { agentePublicado: true }],
    ["logo", { logoDefinido: true }],
    ["followup", { followupAtivo: true }],
    ["equipe", { membrosAtivos: 2 }],
  ] as const)("cada item muda sozinho: só %s fica feito", (id, mudanca) => {
    const r = feito({ ...TUDO_PENDENTE, ...mudanca });
    for (const [outro, valor] of Object.entries(r)) expect(valor, outro).toBe(outro === id);
  });

  it("a contagem de obrigatórios acompanha cada combinação dos quatro", () => {
    for (let mascara = 0; mascara < 16; mascara++) {
      const dados = {
        ...TUDO_PENDENTE,
        planoAtivo: Boolean(mascara & 1),
        emailVerificado: Boolean(mascara & 2),
        oQueFaz: mascara & 4 ? "faço bolo" : null,
        whatsappConectado: Boolean(mascara & 8),
      };
      const feitos = [1, 2, 4, 8].filter((bit) => mascara & bit).length;
      const { contagem } = primeirosPassos(dados);
      expect(contagem.obrigatoriosFeitos, `máscara ${mascara}`).toBe(feitos);
      expect(contagem.obrigatoriosFaltando, `máscara ${mascara}`).toBe(4 - feitos);
    }
  });

  it("perfil da empresa exige o que faz E o fuso; texto só com espaços não conta", () => {
    expect(feito({ ...TUDO_PENDENTE, oQueFaz: "   ", fuso: "America/Sao_Paulo" }).perfil).toBe(false);
    expect(feito({ ...TUDO_PENDENTE, oQueFaz: "clínica", fuso: null }).perfil).toBe(false);
    expect(feito({ ...TUDO_PENDENTE, oQueFaz: "clínica", fuso: "" }).perfil).toBe(false);
    expect(feito({ ...TUDO_PENDENTE, oQueFaz: "clínica", fuso: "America/Sao_Paulo" }).perfil).toBe(true);
  });

  it("equipe só conta com mais de um membro ativo (o próprio dono sozinho não)", () => {
    expect(feito({ ...TUDO_PENDENTE, membrosAtivos: 0 }).equipe).toBe(false);
    expect(feito({ ...TUDO_PENDENTE, membrosAtivos: 1 }).equipe).toBe(false);
    expect(feito({ ...TUDO_PENDENTE, membrosAtivos: 2 }).equipe).toBe(true);
  });

  it("sem compra ligada, plano e e-mail nem aparecem e não pesam na conta", () => {
    const r = primeirosPassos({ ...TUDO_PENDENTE, compraLigada: false });
    expect(r.passos.map((p) => p.id)).not.toContain("plano");
    expect(r.passos.map((p) => p.id)).not.toContain("email");
    expect(r.contagem.obrigatoriosTotal).toBe(2);
    expect(r.contagem.obrigatoriosFaltando).toBe(2);
  });

  it("sem o módulo de marca por organização, o logo não aparece", () => {
    const r = primeirosPassos({ ...TUDO_PENDENTE, marcaPorOrganizacaoLigada: false });
    expect(r.passos.map((p) => p.id)).not.toContain("logo");
    expect(r.contagem.opcionaisTotal).toBe(3);
  });

  it("todo passo tem título, descrição, destino dentro de /app e botão; ids únicos", () => {
    const { passos } = primeirosPassos(TUDO_PENDENTE);
    expect(new Set(passos.map((p) => p.id)).size).toBe(passos.length);
    for (const p of passos) {
      expect(p.titulo.trim(), p.id).not.toBe("");
      expect(p.descricao.trim(), p.id).not.toBe("");
      expect(p.cta.trim(), p.id).not.toBe("");
      expect(p.href.startsWith("/app/"), p.id).toBe(true);
    }
  });

  it("a voz é a do cliente, nunca a do instalador", () => {
    const texto = primeirosPassos(TUDO_PENDENTE)
      .passos.map((p) => `${p.titulo} ${p.descricao} ${p.cta}`)
      .join(" ")
      .toLowerCase();
    expect(texto).not.toContain("de pé");
    expect(texto).not.toContain("instala");
  });
});
