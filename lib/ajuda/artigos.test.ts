import { describe, expect, it } from "vitest";

import {
  ARTIGOS_POR_ABA,
  ARTIGOS_POR_ROTA,
  CAMINHO_CAMPOS_PERSONALIZADOS,
  CAMINHO_CONECTAR_ASSISTENTE_DE_IA,
  CAMINHO_CONECTAR_FORMULARIOS,
  CAMINHO_PADRAO_DA_AJUDA,
  artigoDaAba,
  artigoProprio,
  baseDaCentralDeAjuda,
  caminhoDoArtigo,
  urlDaAjuda,
  urlNaCentral,
} from "./artigos";

/**
 * Os artigos que EXISTEM na central (lista fixa, conferida no site publicado em
 * 02/11/2026, mais o de automações que entrou na mesma rodada). Caminho do mapa
 * fora desta lista é link quebrado: o teste reprova em vez de deixar o cliente
 * cair numa página 404. Artigo novo na central entra aqui primeiro.
 */
const ARTIGOS_DA_CENTRAL = new Set([
  "/crm/primeiros-passos/criar-conta-e-assinar/",
  "/crm/primeiros-passos/tela-inicio/",
  "/crm/primeiros-passos/confirmar-email/",
  "/crm/primeiros-passos/conhecer-o-menu/",
  "/crm/whatsapp/conectar-pelo-qr-code/",
  "/crm/whatsapp/conectar-numero-oficial-da-meta/",
  "/crm/funis-e-leads/funis-e-etapas/",
  "/crm/funis-e-leads/contatos/",
  "/crm/funis-e-leads/campos-personalizados/",
  "/crm/funis-e-leads/tags/",
  "/crm/agente-de-ia/criar-e-publicar-o-agente/",
  "/crm/agente-de-ia/modelos-do-plano-e-chave-propria/",
  "/crm/agente-de-ia/decisoes-rapidas-jev/",
  "/crm/receber-leads/fontes-de-captacao/",
  "/crm/receber-leads/conectar-formularios-e-n8n/",
  "/crm/receber-leads/campos-aceitos-e-recadastro/",
  "/crm/receber-leads/leads-recebidos/",
  "/crm/equipe/convidar-pessoas/",
  "/crm/equipe/papeis/",
  "/crm/agenda/google-agenda/",
  "/crm/assinatura/meu-plano/",
  "/crm/assinatura/cupom/",
  "/crm/assinatura/cancelar/",
  "/crm/assinatura/reembolso/",
  "/crm/assinatura/exclusao-dos-dados/",
  "/crm/integracoes-e-api/tokens-de-api/",
  "/crm/integracoes-e-api/referencia-da-api/",
  "/crm/integracoes-e-api/conectar-assistente-de-ia/",
  "/crm/privacidade/lgpd/",
  "/crm/automacoes/criar-uma-automacao/",
  "/crm/automacoes/ver-execucoes/",
  "/crm/automacoes/regras-em-automacoes-e-webhooks/",
]);

describe("caminhoDoArtigo", () => {
  it("manda cada tela principal para o artigo dela", () => {
    expect(caminhoDoArtigo("/app/inicio")).toBe("/crm/primeiros-passos/tela-inicio/");
    expect(caminhoDoArtigo("/app/inbox")).toBe("/crm/whatsapp/conectar-pelo-qr-code/");
    expect(caminhoDoArtigo("/app/kanban")).toBe("/crm/funis-e-leads/funis-e-etapas/");
    expect(caminhoDoArtigo("/app/contacts")).toBe("/crm/funis-e-leads/contatos/");
    expect(caminhoDoArtigo("/app/ai/agents")).toBe("/crm/agente-de-ia/criar-e-publicar-o-agente/");
    expect(caminhoDoArtigo("/app/agenda")).toBe("/crm/agenda/google-agenda/");
    expect(caminhoDoArtigo("/app/team")).toBe("/crm/equipe/convidar-pessoas/");
    expect(caminhoDoArtigo("/app/settings/plano")).toBe("/crm/assinatura/meu-plano/");
    expect(caminhoDoArtigo("/app/webhooks")).toBe("/crm/automacoes/regras-em-automacoes-e-webhooks/");
    expect(caminhoDoArtigo("/app/settings/api-tokens")).toBe(
      "/crm/integracoes-e-api/tokens-de-api/",
    );
    expect(caminhoDoArtigo("/app/lgpd/requests")).toBe("/crm/privacidade/lgpd/");
  });

  it("o prefixo mais longo vence", () => {
    // `/app/ai` é o artigo do agente; `/app/ai/jev` e `/app/ai/credentials` têm o seu.
    expect(caminhoDoArtigo("/app/ai/jev")).toBe("/crm/agente-de-ia/decisoes-rapidas-jev/");
    expect(caminhoDoArtigo("/app/ai/credentials")).toBe(
      "/crm/agente-de-ia/modelos-do-plano-e-chave-propria/",
    );
    expect(caminhoDoArtigo("/app/ai/agents/abc-123")).toBe(
      "/crm/agente-de-ia/criar-e-publicar-o-agente/",
    );
    // `/app/settings/tenant/agenda` ganha de qualquer prefixo mais curto.
    expect(caminhoDoArtigo("/app/settings/tenant/agenda")).toBe("/crm/agenda/google-agenda/");
    expect(caminhoDoArtigo("/app/settings/tenant/pipelines/x")).toBe(
      "/crm/funis-e-leads/funis-e-etapas/",
    );
  });

  it("subrota herda o artigo da tela-mãe", () => {
    expect(caminhoDoArtigo("/app/team/invite")).toBe("/crm/equipe/convidar-pessoas/");
    expect(caminhoDoArtigo("/app/leads/9f1c")).toBe("/crm/funis-e-leads/funis-e-etapas/");
  });

  it("só casa em fronteira de segmento", () => {
    expect(caminhoDoArtigo("/app/teams")).toBe(CAMINHO_PADRAO_DA_AJUDA);
    expect(caminhoDoArtigo("/app/inboxes")).toBe(CAMINHO_PADRAO_DA_AJUDA);
  });

  it("ignora query, âncora e barra final", () => {
    expect(caminhoDoArtigo("/app/contacts/?q=ana#topo")).toBe("/crm/funis-e-leads/contatos/");
    expect(caminhoDoArtigo("/app/inbox?conversation=1")).toBe(
      "/crm/whatsapp/conectar-pelo-qr-code/",
    );
  });

  it("sem correspondência, vai para a página do produto", () => {
    expect(caminhoDoArtigo("/app/tela-que-nao-existe")).toBe("/crm/");
    expect(caminhoDoArtigo("/app")).toBe("/crm/");
    expect(caminhoDoArtigo("/login")).toBe("/crm/");
    expect(caminhoDoArtigo("")).toBe("/crm/");
    expect(caminhoDoArtigo(null)).toBe("/crm/");
    expect(caminhoDoArtigo(undefined)).toBe("/crm/");
  });

  it("todo caminho mapeado é do formato /crm/<grupo>/<artigo>/", () => {
    for (const [rota, caminho] of Object.entries(ARTIGOS_POR_ROTA)) {
      expect(rota, "rota do CRM").toMatch(/^\/app(\/[a-z0-9-]+)+$/);
      expect(caminho, `artigo de ${rota}`).toMatch(/^\/crm\/[a-z0-9-]+\/[a-z0-9-]+\/$/);
    }
  });
});

describe("todo caminho do código existe na central", () => {
  it("ARTIGOS_POR_ROTA", () => {
    for (const [rota, caminho] of Object.entries(ARTIGOS_POR_ROTA)) {
      expect(ARTIGOS_DA_CENTRAL.has(caminho), `${rota} -> ${caminho}`).toBe(true);
    }
  });

  it("ARTIGOS_POR_ABA e os artigos de seção", () => {
    for (const [rota, abas] of Object.entries(ARTIGOS_POR_ABA)) {
      for (const [aba, caminho] of Object.entries(abas)) {
        expect(ARTIGOS_DA_CENTRAL.has(caminho), `${rota}?tab=${aba} -> ${caminho}`).toBe(true);
      }
    }
    expect(ARTIGOS_DA_CENTRAL.has(CAMINHO_CONECTAR_FORMULARIOS)).toBe(true);
    expect(ARTIGOS_DA_CENTRAL.has(CAMINHO_CONECTAR_ASSISTENTE_DE_IA)).toBe(true);
    expect(ARTIGOS_DA_CENTRAL.has(CAMINHO_CAMPOS_PERSONALIZADOS)).toBe(true);
  });
});

describe("artigoDaAba", () => {
  it("cada aba de Automações e webhooks leva ao seu artigo", () => {
    expect(artigoDaAba("/app/webhooks", "sources")).toBe("/crm/receber-leads/fontes-de-captacao/");
    expect(artigoDaAba("/app/webhooks", "capturas")).toBe("/crm/receber-leads/leads-recebidos/");
    expect(artigoDaAba("/app/webhooks", "rules")).toBe("/crm/automacoes/regras-em-automacoes-e-webhooks/");
  });

  it("aba sem artigo, aba desconhecida ou sem aba: null", () => {
    expect(artigoDaAba("/app/webhooks", "activity")).toBeNull();
    expect(artigoDaAba("/app/webhooks", "toString")).toBeNull();
    expect(artigoDaAba("/app/webhooks", "inventada")).toBeNull();
    expect(artigoDaAba("/app/webhooks", null)).toBeNull();
    expect(artigoDaAba("/app/contacts", "sources")).toBeNull();
    expect(artigoDaAba(null, "sources")).toBeNull();
  });

  it("aceita barra final e query na rota, mas não subrota", () => {
    expect(artigoDaAba("/app/webhooks/?x=1", "capturas")).toBe(
      "/crm/receber-leads/leads-recebidos/",
    );
    expect(artigoDaAba("/app/webhooks/abc", "capturas")).toBeNull();
  });
});

describe("artigoProprio", () => {
  it("nunca cai na página genérica", () => {
    expect(artigoProprio("/app/qualquer")).toBeNull();
    expect(artigoProprio("/app/settings")).toBeNull();
    expect(artigoProprio(null)).toBeNull();
    expect(artigoProprio("/app/contacts")).toBe("/crm/funis-e-leads/contatos/");
  });

  it("a aba vence a rota; aba sem artigo fica com a rota", () => {
    expect(artigoProprio("/app/webhooks", "capturas")).toBe("/crm/receber-leads/leads-recebidos/");
    expect(artigoProprio("/app/webhooks", "activity")).toBe(
      "/crm/automacoes/regras-em-automacoes-e-webhooks/",
    );
  });

  it("o fluxo de assinatura tem o seu artigo, à frente de Meu plano", () => {
    expect(artigoProprio("/app/settings/plano/assinar")).toBe(
      "/crm/primeiros-passos/criar-conta-e-assinar/",
    );
    expect(artigoProprio("/app/settings/plano/pedido/1")).toBe("/crm/assinatura/meu-plano/");
  });
});

describe("baseDaCentralDeAjuda", () => {
  it("aceita http(s) e tira a barra final", () => {
    expect(baseDaCentralDeAjuda("https://ajuda.exemplo.com")).toBe("https://ajuda.exemplo.com");
    expect(baseDaCentralDeAjuda("  https://ajuda.exemplo.com/  ")).toBe(
      "https://ajuda.exemplo.com",
    );
    expect(baseDaCentralDeAjuda("https://exemplo.com/ajuda/")).toBe("https://exemplo.com/ajuda");
  });

  it("vazio, lixo e esquema perigoso viram null", () => {
    expect(baseDaCentralDeAjuda("")).toBeNull();
    expect(baseDaCentralDeAjuda("   ")).toBeNull();
    expect(baseDaCentralDeAjuda(undefined)).toBeNull();
    expect(baseDaCentralDeAjuda(null)).toBeNull();
    expect(baseDaCentralDeAjuda("ajuda.exemplo.com")).toBeNull();
    expect(baseDaCentralDeAjuda("javascript:alert(1)")).toBeNull();
    expect(baseDaCentralDeAjuda("ftp://exemplo.com")).toBeNull();
    expect(baseDaCentralDeAjuda("https://user:senha@exemplo.com")).toBeNull();
  });
});

describe("urlDaAjuda", () => {
  it("junta a base da instalação ao artigo da tela", () => {
    expect(urlDaAjuda("https://ajuda.exemplo.com/", "/app/contacts")).toBe(
      "https://ajuda.exemplo.com/crm/funis-e-leads/contatos/",
    );
  });

  it("com base sob subcaminho, preserva o subcaminho", () => {
    expect(urlDaAjuda("https://exemplo.com/ajuda", "/app/team")).toBe(
      "https://exemplo.com/ajuda/crm/equipe/convidar-pessoas/",
    );
  });

  it("sem base configurada não há URL (o botão não aparece)", () => {
    expect(urlDaAjuda("", "/app/contacts")).toBeNull();
    expect(urlDaAjuda(undefined, "/app/contacts")).toBeNull();
    expect(urlDaAjuda("lixo", "/app/contacts")).toBeNull();
  });

  it("tela sem artigo cai na página do produto", () => {
    expect(urlDaAjuda("https://ajuda.exemplo.com", "/app/qualquer")).toBe(
      "https://ajuda.exemplo.com/crm/",
    );
  });

  it("respeita a aba quando ela tem artigo", () => {
    expect(urlDaAjuda("https://ajuda.exemplo.com", "/app/webhooks", "capturas")).toBe(
      "https://ajuda.exemplo.com/crm/receber-leads/leads-recebidos/",
    );
    expect(urlDaAjuda("https://ajuda.exemplo.com", "/app/webhooks", "activity")).toBe(
      "https://ajuda.exemplo.com/crm/automacoes/regras-em-automacoes-e-webhooks/",
    );
  });
});

describe("urlNaCentral", () => {
  it("junta base e caminho; sem um dos dois, null", () => {
    expect(urlNaCentral("https://ajuda.exemplo.com/", CAMINHO_PADRAO_DA_AJUDA)).toBe(
      "https://ajuda.exemplo.com/crm/",
    );
    expect(urlNaCentral(null, CAMINHO_PADRAO_DA_AJUDA)).toBeNull();
    expect(urlNaCentral("https://ajuda.exemplo.com", null)).toBeNull();
  });
});
