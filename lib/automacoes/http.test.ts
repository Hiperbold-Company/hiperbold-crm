/**
 * Bloco "Requisição HTTP" — as regras puras: máscara da chave, leitura de
 * caminho no JSON, cabeçalho proibido, chave recusada na URL, e a validação de
 * publicação que a tela lê.
 */
import { describe, expect, it } from "vitest";

import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import {
  cabecalhoComSegredoEscrito,
  cabecalhoProibido,
  cabecalhoSensivel,
  httpRequestConfigSchema,
  porNoCaminhoDoCorpo,
  ultimos4,
  lerCaminhoNoJson,
  mascararSegredos,
  preencherCorpoJson,
  problemaDaUrl,
  valorComoTexto,
  type HttpRequestConfig,
} from "./http";

const CHAVE = "11111111-2222-4333-8444-555555555555";

describe("máscara da chave secreta", () => {
  it("troca toda ocorrência por ••••, inclusive o eco do servidor", () => {
    expect(mascararSegredos("token=abc12345 e de novo abc12345", ["abc12345"])).toBe("token=•••• e de novo ••••");
  });
  it("mascara a mais longa primeiro (uma chave dentro de outra não sobra pela metade)", () => {
    expect(mascararSegredos("xyzSEGREDO_LONGO", ["SEGREDO", "SEGREDO_LONGO"])).toBe("xyz••••");
  });
  it("sem chave, o texto sai igual (controle)", () => {
    expect(mascararSegredos("nada aqui", [])).toBe("nada aqui");
  });
});

describe("caminho no JSON da resposta", () => {
  const json = { campaign: { name: "Black Friday", id: 42 }, data: [{ id: "a" }, { id: "b" }], ok: true };
  it("desce por ponto e por índice", () => {
    expect(lerCaminhoNoJson(json, "campaign.name")).toBe("Black Friday");
    expect(lerCaminhoNoJson(json, "data[1].id")).toBe("b");
  });
  it("caminho que não existe devolve undefined", () => {
    expect(lerCaminhoNoJson(json, "campaign.nada")).toBeUndefined();
    expect(lerCaminhoNoJson(json, "data[9].id")).toBeUndefined();
  });
  it("não sobe pelo protótipo", () => {
    expect(lerCaminhoNoJson(json, "constructor")).toBeUndefined();
    expect(lerCaminhoNoJson(json, "campaign.toString")).toBeUndefined();
  });
  it("número e objeto viram texto; ausente é null", () => {
    expect(valorComoTexto(lerCaminhoNoJson(json, "campaign.id"))).toBe("42");
    expect(valorComoTexto(lerCaminhoNoJson(json, "data[0]"))).toBe('{"id":"a"}');
    expect(valorComoTexto(undefined)).toBeNull();
  });
});

describe("cabeçalhos proibidos", () => {
  it("recusa transporte e cookie, sem diferenciar maiúscula", () => {
    for (const h of ["Host", "content-length", "Transfer-Encoding", "Cookie", "CONNECTION"]) {
      expect(cabecalhoProibido(h)).toBe(true);
    }
  });
  it("aceita Authorization e X-Api-Key (controle)", () => {
    expect(cabecalhoProibido("Authorization")).toBe(false);
    expect(cabecalhoProibido("X-Api-Key")).toBe(false);
  });
});

describe("URL do bloco", () => {
  it("{{segredo...}} na URL é recusado", () => {
    expect(problemaDaUrl("https://api.exemplo.com/x?token={{segredo.token_meta}}")).toBe("segredo_na_url");
    expect(problemaDaUrl("https://api.exemplo.com/{{ secret.x }}")).toBe("segredo_na_url");
  });
  it("http, usuário e senha e URL torta são recusados", () => {
    expect(problemaDaUrl("http://api.exemplo.com/x")).toBe("https_obrigatorio");
    expect(problemaDaUrl("https://user:senha@api.exemplo.com/x")).toBe("credencial_na_url");
    expect(problemaDaUrl("https://")).toBe("vazia");
    expect(problemaDaUrl("isto não é url")).toBe("invalida");
  });
  it("URL com variável no caminho passa (controle)", () => {
    expect(problemaDaUrl("https://graph.facebook.com/v19.0/{{campo.source_id}}?fields=campaign")).toBeNull();
  });
});

describe("corpo JSON", () => {
  it("o valor preenchido é escapado (aspas não quebram nem injetam campo)", () => {
    const obj = preencherCorpoJson('{"nome": "{{x}}"}', (t) => t.replace("{{x}}", 'a", "admin": "true'));
    expect(JSON.stringify(obj)).toBe('{"nome":"a\\", \\"admin\\": \\"true"}');
  });
});

function grafo(config: HttpRequestConfig): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      { id: "h", type: "http_request", label: "Chamar API", position: { x: 0, y: 100 }, config },
      { id: "f", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "t", target: "h", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "h", target: "f", priority: 0, condition: { type: "always" } },
      { id: "e3", source: "h", target: "f", priority: 1, condition: { type: "branch", branch_id: "erro" } },
    ],
  });
}

const BASE: HttpRequestConfig = {
  method: "GET",
  url: "https://api.exemplo.com/v1/{{campo.source_id}}",
  headers: [{ kind: "chave", name: "Authorization", secret_id: CHAVE, prefix: "Bearer " }],
  timeout_ms: 10_000,
  mappings: [{ path: "campaign.name", var: "utm_campaign", to: { scope: "lead_custom", key: "utm_campaign" } }],
};

function codigos(config: HttpRequestConfig, segredos?: Set<string>): string[] {
  const r = validateFlowForPublish(grafo(config), {
    surface: "automacao",
    automacao: { pointerId: "p", ...(segredos ? { segredosExistentes: segredos } : {}) },
  });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("publicação do bloco HTTP", () => {
  it("bloco completo, com a chave existente, publica (controle)", () => {
    expect(codigos(BASE, new Set([CHAVE])).filter((c) => c.startsWith("http_"))).toEqual([]);
  });
  it("chave citada que não existe nesta organização é recusada", () => {
    expect(codigos(BASE, new Set())).toContain("http_segredo_inexistente");
  });
  it("{{segredo}} na URL e no cabeçalho de texto são recusados", () => {
    expect(codigos({ ...BASE, url: "https://api.exemplo.com/?k={{segredo.token_meta}}" })).toContain("http_segredo_na_url");
    expect(
      codigos({ ...BASE, headers: [{ kind: "texto", name: "X-Api-Key", value: "{{segredo.token_meta}}" }] }),
    ).toContain("http_segredo_no_texto");
  });
  it("cabeçalho proibido é recusado", () => {
    expect(codigos({ ...BASE, headers: [{ kind: "texto", name: "Host", value: "interno" }] })).toContain(
      "http_cabecalho_proibido",
    );
  });
  it("URL vazia, corpo em GET e corpo que não é JSON são recusados", () => {
    expect(codigos({ ...BASE, url: "https://" })).toContain("http_url_invalida");
    expect(codigos({ ...BASE, body: '{"a": 1}' })).toContain("http_corpo_no_get");
    expect(codigos({ ...BASE, method: "POST", body: '{"a": {{x}} }' })).toContain("http_corpo_invalido");
  });
  it("mapear para campo só de leitura é recusado", () => {
    expect(codigos({ ...BASE, mappings: [{ path: "x", var: "x", to: { scope: "contact", key: "email" } }] })).toContain(
      "campo_so_leitura",
    );
  });
  it("o schema recusa nome de variável inválido e nome repetido", () => {
    expect(httpRequestConfigSchema.safeParse({ ...BASE, mappings: [{ path: "a", var: "Nome Ruim" }] }).success).toBe(false);
    expect(
      httpRequestConfigSchema.safeParse({ ...BASE, mappings: [{ path: "a", var: "x" }, { path: "b", var: "x" }] }).success,
    ).toBe(false);
  });
  it("o bloco não roda num follow-up", () => {
    const r = validateFlowForPublish(grafo(BASE), { surface: "followup" });
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain("no_fora_da_superficie");
  });
});

describe("auditoria do lote 4", () => {
  it("1. nome sensível com valor escrito é segredo no grafo; variável pura e nome comum não", () => {
    for (const nome of ["Authorization", "authorization", "X-Api-Key", "Api-Key", "apikey", "X-Auth-Token", "Client-Secret", "x-partner-key"]) {
      expect(cabecalhoSensivel(nome)).toBe(true);
      expect(cabecalhoComSegredoEscrito({ kind: "texto", name: nome, value: "Bearer abc123" })).toBe(true);
      expect(cabecalhoComSegredoEscrito({ kind: "texto", name: nome, value: "{{campo.token}}" })).toBe(false);
    }
    expect(cabecalhoSensivel("Accept")).toBe(false);
    expect(cabecalhoComSegredoEscrito({ kind: "texto", name: "Accept", value: "application/json" })).toBe(false);
  });

  it("1. o publish recusa token escrito em Authorization, com a frase que manda ao cofre", () => {
    const cfg: HttpRequestConfig = { ...BASE, headers: [{ kind: "texto", name: "Authorization", value: "Bearer abc123" }] };
    const r = validateFlowForPublish(grafo(cfg), { surface: "automacao", automacao: { pointerId: "p", segredosExistentes: new Set([CHAVE]) } });
    expect(r.ok).toBe(false);
    const erro = r.ok ? undefined : r.errors.find((e) => e.code === "http_segredo_no_texto");
    expect(erro?.message).toContain("Guarde este valor em Chaves secretas");
    // Controle: variável pura no mesmo cabeçalho publica.
    const ok: HttpRequestConfig = { ...BASE, headers: [{ kind: "texto", name: "Authorization", value: "{{campo.token}}" }] };
    expect(codigos(ok, new Set([CHAVE]))).not.toContain("http_segredo_no_texto");
  });

  it("1. chave do cofre num campo do corpo: o schema aceita um, o publish confere o campo", () => {
    const cfg: HttpRequestConfig = {
      ...BASE,
      method: "POST",
      body: '{"auth": {"token": ""}, "nome": "{{contact.name}}"}',
      body_secrets: [{ path: "auth.token", secret_id: CHAVE, prefix: "" }],
    };
    expect(httpRequestConfigSchema.safeParse(cfg).success).toBe(true);
    expect(codigos(cfg, new Set([CHAVE])).filter((c) => c.startsWith("http_"))).toEqual([]);
    expect(codigos({ ...cfg, body_secrets: [{ path: "auth.outro", secret_id: CHAVE, prefix: "" }] }, new Set([CHAVE]))).toContain("http_corpo_invalido");
    expect(codigos(cfg, new Set())).toContain("http_segredo_inexistente");
    const dois = { ...cfg, body_secrets: [cfg.body_secrets![0]!, { path: "nome", secret_id: CHAVE, prefix: "" }] };
    expect(httpRequestConfigSchema.safeParse(dois).success).toBe(false);
    const obj = JSON.parse(cfg.body!);
    expect(porNoCaminhoDoCorpo(obj, "auth.token", "S")).toBe(true);
    expect(obj.auth.token).toBe("S");
    expect(porNoCaminhoDoCorpo(obj, "auth.novo", "S")).toBe(false);
    expect(porNoCaminhoDoCorpo(obj, "auth", "S")).toBe(false);
  });

  it("2. variável no domínio ou na porta é recusada; no caminho passa", () => {
    for (const url of ["https://api.{{campo.x}}/v1", "https://api.x.com{{campo.y}}/v1", "https://api.x.com:{{campo.p}}/v1", "https://{{campo.h}}"]) {
      expect(problemaDaUrl(url)).toBe("variavel_no_dominio");
      expect(codigos({ ...BASE, url }, new Set([CHAVE]))).toContain("http_url_invalida");
    }
    expect(problemaDaUrl("https://api.x.com/v1/{{campo.y}}?q={{campo.z}}")).toBeNull();
  });

  it("6. a máscara cobre a chave codificada na URL, em base64 (com e sem prefixo) e escapada em JSON", () => {
    const s = 'ab+c/d"e\\f=g&h';
    const eco = [
      encodeURIComponent(s),
      btoa(s),
      btoa(`user:${s}`),
      JSON.stringify(s).slice(1, -1),
    ].join(" | ");
    const mascarado = mascararSegredos(eco, [s], ["user:"]);
    expect(mascarado).toBe("•••• | •••• | •••• | ••••");
  });

  it("7. os finais só aparecem em chave com 16 caracteres ou mais", () => {
    expect(ultimos4("abcdefghijk1234")).toBe("");
    expect(ultimos4("abcdefghijkl1234")).toBe("1234");
  });
});
