import { describe, expect, it } from "vitest";

import {
  ARTIGOS_POR_ROTA,
  CAMINHO_PADRAO_DA_AJUDA,
  baseDaCentralDeAjuda,
  caminhoDoArtigo,
  urlDaAjuda,
} from "./artigos";

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
    expect(caminhoDoArtigo("/app/webhooks")).toBe("/crm/receber-leads/fontes-de-captacao/");
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
});
