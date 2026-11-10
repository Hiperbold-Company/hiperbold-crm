/**
 * O efeito do bloco "Requisição HTTP".
 *
 * O que roda de verdade: `executarHttp` inteiro (template, guarda textual,
 * cabeçalhos, máscara, mapeamentos) e, no último bloco, o fetch seguro de
 * PRODUÇÃO (`criarFetchSeguro` → `buscarNoEnderecoValidado`) contra um
 * receptor HTTP real em 127.0.0.1. Dublês: o banco (o cofre devolve a chave
 * "decifrada") e, no último bloco, só a resolução de DNS e o transporte TLS
 * (o receptor é http puro na máquina do teste).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { criarFetchSeguro, type RequisicaoHttps } from "@/lib/ai/mcp-externo/fetch-seguro";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";

import type { FatosDaAutomacao } from "../fatos";
import type { HttpRequestConfig } from "../http";
import { executarHttp, type NoHttp } from "./http";
import type { Contexto, Passo } from "./index";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const CHAVE_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const TOKEN = "tok_SUPERSECRETO_123456";

type Linha = { id: string; organization_id: string; valor_cifrado: string };

function bancoDuble(linhas: Linha[]) {
  const usados: string[] = [];
  return {
    usados,
    admin: {
      from(tabela: string) {
        const filtros: Record<string, unknown> = {};
        let ids: string[] = [];
        let atualizacao = false;
        const q = {
          select: () => q,
          update: () => ((atualizacao = true), q),
          eq: (c: string, v: unknown) => ((filtros[c] = v), q),
          in: (_c: string, v: string[]) => {
            ids = v;
            if (atualizacao) {
              usados.push(...v);
              return Promise.resolve({ data: null, error: null });
            }
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
    },
  };
}

function contexto(
  admin: unknown,
  fatos: Partial<FatosDaAutomacao> = {},
  vars: Record<string, unknown> = { gatilho: { fonte: "x" } },
): Contexto {
  return {
    admin: admin as Contexto["admin"],
    org: ORG,
    pointerId: "p1",
    enrollmentId: "e1",
    chave: "h:1",
    contatoId: "c1",
    fatos: { contato: null, negocio: null, negocios: [], vars, ...fatos } as FatosDaAutomacao,
    vars,
    handler: {} as HandlerCtx,
    agora: new Date("2026-11-10T12:00:00Z"),
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
      url: "https://api.exemplo.com/v1/{{gatilho.fonte}}",
      headers: [{ kind: "chave", name: "Authorization", secret_id: CHAVE_ID, prefix: "Bearer " }],
      timeout_ms: 10_000,
      mappings: [{ path: "campaign.name", var: "utm_campaign" }],
      ...config,
    },
  } as NoHttp;
}

const semCampos = async (): Promise<Passo> => ({ ok: true, detalhe: {} });

function fetchQueResponde(corpo: unknown, status = 200) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });
  });
  return { fetch, chamadas };
}

const linhas: Linha[] = [{ id: CHAVE_ID, organization_id: ORG, valor_cifrado: "\\xcifrado" }];

describe("executarHttp — o envio", () => {
  it("monta a URL com a variável codificada, manda a chave no cabeçalho e guarda o campo mapeado", async () => {
    const { admin, usados } = bancoDuble(linhas);
    const { fetch, chamadas } = fetchQueResponde({ campaign: { name: "Black Friday" } });
    const r = await executarHttp(contexto(admin, {}, { gatilho: { fonte: "a/b c" } }), no({}), {
      fetch,
      gravarCampos: semCampos,
    });
    expect(r.desfecho).toEqual({ ok: true });
    expect(chamadas[0]!.url).toBe("https://api.exemplo.com/v1/a%2Fb%20c");
    expect(new Headers(chamadas[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(r.vars).toEqual({ saida: { utm_campaign: "Black Friday" } });
    expect(usados).toEqual([CHAVE_ID]);
    // O detalhe do evento: método, host, caminho, status, campos — nunca a chave.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.detalhes?.[0]).toMatchObject({
      tipo: "http_request",
      ok: true,
      metodo: "GET",
      host: "api.exemplo.com",
      status: 200,
      campos: ["utm_campaign"],
    });
  });

  it("o servidor que ECOA o token tem o valor mascarado antes de gravar", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ campaign: { name: `recebi ${TOKEN}` } });
    const r = await executarHttp(contexto(admin), no({}), { fetch, gravarCampos: semCampos });
    expect(r.vars).toEqual({ saida: { utm_campaign: "recebi ••••" } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("mantém o que blocos anteriores guardaram em saida", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ campaign: { name: "X" } });
    const r = await executarHttp(
      contexto(admin, {}, { gatilho: { fonte: "x" }, saida: { anterior: "1" } }),
      no({}),
      { fetch, gravarCampos: semCampos },
    );
    expect(r.vars).toEqual({ saida: { anterior: "1", utm_campaign: "X" } });
  });

  it("mapeamento com campo de destino grava pela operação de campo (valor literal)", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ campaign: { name: "{{contact.name}}" } });
    const gravar = vi.fn(semCampos);
    await executarHttp(
      contexto(admin),
      no({
        mappings: [
          { path: "campaign.name", var: "utm", to: { scope: "lead_custom", key: "utm_campaign" } },
        ],
      }),
      { fetch, gravarCampos: gravar },
    );
    expect(gravar).toHaveBeenCalledWith([
      {
        target: { scope: "lead_custom", key: "utm_campaign" },
        op: "set",
        value: "{{contact.name}}",
      },
    ]);
  });

  it("POST: corpo JSON com a variável escapada e content-type", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch, chamadas } = fetchQueResponde({});
    await executarHttp(
      contexto(admin, {}, { gatilho: { fonte: 'x"y' } }),
      no({ method: "POST", body: '{"origem": "{{gatilho.fonte}}"}', mappings: [] }),
      { fetch, gravarCampos: semCampos },
    );
    expect(chamadas[0]!.init.body).toBe('{"origem":"x\\"y"}');
    expect(new Headers(chamadas[0]!.init.headers).get("content-type")).toBe("application/json");
  });
});

describe("executarHttp — as recusas (sem chamar a rede)", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data", "http_https_obrigatorio"],
    ["https://169.254.169.254/latest/meta-data", "http_destino_recusado"],
    ["https://localhost/admin", "http_destino_recusado"],
    ["https://10.0.0.5/x", "http_destino_recusado"],
  ])("%s → %s", async (url, erro) => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(contexto(admin), no({ url }), { fetch, gravarCampos: semCampos });
    expect(r.desfecho).toEqual({ ok: false, erro });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("{{segredo}} na URL é recusado", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(
      contexto(admin),
      no({ url: "https://api.exemplo.com/?k={{segredo.token}}" }),
      { fetch, gravarCampos: semCampos },
    );
    expect(r.desfecho.erro).toBe("http_segredo_na_url");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cabeçalho proibido é recusado no motor também", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(
      contexto(admin),
      no({ headers: [{ kind: "texto", name: "Host", value: "interno" }] }),
      {
        fetch,
        gravarCampos: semCampos,
      },
    );
    expect(r.desfecho.erro).toBe("http_cabecalho_proibido");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("chave de OUTRA organização não é lida: sai por Falhou", async () => {
    const { admin } = bancoDuble([
      { id: CHAVE_ID, organization_id: OUTRA_ORG, valor_cifrado: "\\xcifrado" },
    ]);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(contexto(admin), no({}), { fetch, gravarCampos: semCampos });
    expect(r.desfecho.erro).toBe("segredo_inexistente");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resposta fora de 2xx sai por Falhou com o status; nada é guardado", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ erro: `token ${TOKEN} inválido` }, 401);
    const r = await executarHttp(contexto(admin), no({}), { fetch, gravarCampos: semCampos });
    expect(r.desfecho.erro).toBe("http_status:401");
    expect(r.vars).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("tempo esgotado sai por Falhou", async () => {
    const { admin } = bancoDuble(linhas);
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    const r = await executarHttp(contexto(admin), no({}), { fetch, gravarCampos: semCampos });
    expect(r.desfecho.erro).toBe("http_tempo_esgotado");
  });

  it("redirecionamento não é seguido", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde("", 302);
    const r = await executarHttp(contexto(admin), no({}), { fetch, gravarCampos: semCampos });
    expect(r.desfecho.erro).toBe("http_redirecionamento");
  });
});

describe("histórico legível", () => {
  it("“Chamou GET api.exemplo.com/v1/{{gatilho.fonte}} — respondeu 200 …; guardou: utm_campaign”, sem a chave nem o valor preenchido", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ campaign: { name: "X" } });
    const r = await executarHttp(contexto(admin, {}, { gatilho: { fonte: "x" } }), no({}), {
      fetch,
      gravarCampos: semCampos,
    });
    const lido = descreveEvento(
      {
        event_type: "effect_done",
        node_id: "h",
        payload: { desfecho: r.desfecho, detalhes: r.detalhes },
        created_at: "2026-11-10T12:00:00Z",
      } as never,
      {},
      "pt-BR",
      "automacao",
    );
    const texto = `${lido.titulo} ${lido.detalhe ?? ""}`;
    expect(texto).toMatch(
      /Chamou GET api\.exemplo\.com\/v1\/\{\{gatilho\.fonte\}\} — respondeu 200 em \d+ ms; guardou: utm_campaign/,
    );
    expect(texto).not.toContain(TOKEN);
  });
});

describe("pelo fetch seguro de produção, contra um receptor HTTP real", () => {
  let servidor: http.Server;
  let porta = 0;
  const recebidas: Array<{
    url: string;
    authorization: string | undefined;
    host: string | undefined;
  }> = [];

  beforeAll(async () => {
    servidor = http.createServer((req, res) => {
      recebidas.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        host: req.headers.host,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ campaign: { name: `Campanha (eco: ${req.headers.authorization})` } }),
      );
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    porta = (servidor.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => servidor.close(() => r()));
  });

  it("o cabeçalho com a chave chega ao receptor; o eco volta mascarado", async () => {
    // Só o DNS e o TLS são trocados: a conexão abre no IP "validado" (127.0.0.1 do teste) por http.
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
          // O `https.request(url)` de produção manda o Host do nome original; aqui também.
          headers: { ...(opcoes.headers as Record<string, string>), host: url.host },
        },
        cb,
      )) as unknown as RequisicaoHttps;
    const fetch = criarFetchSeguro({ resolverHost: async () => ["127.0.0.1"], requisitar });
    const { admin } = bancoDuble(linhas);
    const r = await executarHttp(contexto(admin, {}, { gatilho: { fonte: "123" } }), no({}), {
      fetch,
      gravarCampos: semCampos,
    });
    expect(r.desfecho).toEqual({ ok: true });
    expect(recebidas).toHaveLength(1);
    expect(recebidas[0]).toMatchObject({
      url: "/v1/123",
      authorization: `Bearer ${TOKEN}`,
      host: "api.exemplo.com",
    });
    expect(r.vars).toEqual({ saida: { utm_campaign: "Campanha (eco: Bearer ••••)" } });
  });

  it("o fetch seguro recusa nome que resolve para IP interno (controle da guarda real)", async () => {
    const fetch = criarFetchSeguro();
    const { admin } = bancoDuble(linhas);
    const antes = recebidas.length;
    const r = await executarHttp(contexto(admin), no({ url: "https://localtest.me/x" }), {
      fetch,
      gravarCampos: semCampos,
    });
    expect(r.desfecho.ok).toBe(false);
    expect(["http_destino_recusado", "http_falha_de_rede"]).toContain(r.desfecho.erro);
    expect(recebidas.length).toBe(antes);
  });
});

describe("auditoria do lote 4 — no motor", () => {
  it("1. Authorization com token ESCRITO sai por Falhou sem chamar a rede; variável pura chama (controle)", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(
      contexto(admin),
      no({ headers: [{ kind: "texto", name: "X-Api-Key", value: "abc123literal" }] }),
      {
        fetch,
        gravarCampos: semCampos,
      },
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "http_segredo_no_texto" });
    expect(fetch).not.toHaveBeenCalled();
    const ok = await executarHttp(
      contexto(admin, {}, { gatilho: { fonte: "x" } }),
      no({
        headers: [{ kind: "texto", name: "X-Api-Key", value: "{{gatilho.fonte}}" }],
        mappings: [],
      }),
      { fetch, gravarCampos: semCampos },
    );
    expect(ok.desfecho).toEqual({ ok: true });
  });

  it("1. chave do cofre no corpo: vai no campo escolhido e nunca volta no resultado", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch, chamadas } = fetchQueResponde({
      eco: `Basic ${btoa(`k:${TOKEN}`)}`,
      campaign: { name: "x" },
    });
    const r = await executarHttp(
      contexto(admin),
      no({
        method: "POST",
        headers: [],
        body: '{"auth": {"token": ""}, "n": 1}',
        body_secrets: [{ path: "auth.token", secret_id: CHAVE_ID, prefix: "k:" }],
        mappings: [{ path: "eco", var: "eco" }],
      }),
      { fetch, gravarCampos: semCampos },
    );
    expect(r.desfecho).toEqual({ ok: true });
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({
      auth: { token: `k:${TOKEN}` },
      n: 1,
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // 6. O eco em base64 do prefixo + chave também é mascarado.
    expect(r.vars).toEqual({ saida: { eco: "Basic ••••" } });
  });

  it.each([
    ["https://api.{{gatilho.fonte}}/v1", "evil.com"],
    ["https://api.exemplo.com{{gatilho.fonte}}/v1", ".evil.com"],
    ["https://api.exemplo.com:{{gatilho.fonte}}/v1", "8443"],
  ])("2. variável na autoridade (%s) é recusada antes de anexar a chave", async (url, fonte) => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({});
    const r = await executarHttp(contexto(admin, {}, { gatilho: { fonte } }), no({ url }), {
      fetch,
      gravarCampos: semCampos,
    });
    expect(r.desfecho).toEqual({ ok: false, erro: "http_url_invalida" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[".."], ["."], [""]])(
    "3. valor %j no caminho não muda o caminho: sai por Falhou",
    async (fonte) => {
      const { admin } = bancoDuble(linhas);
      const { fetch } = fetchQueResponde({});
      const r = await executarHttp(
        contexto(admin, {}, { gatilho: { fonte } }),
        no({ url: "https://api.exemplo.com/v1/{{gatilho.fonte}}/admin" }),
        { fetch, gravarCampos: semCampos },
      );
      expect(r.desfecho).toEqual({ ok: false, erro: "http_url_invalida" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("3. valor com ponto dentro do segmento passa (controle)", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch, chamadas } = fetchQueResponde({ campaign: { name: "x" } });
    const r = await executarHttp(contexto(admin, {}, { gatilho: { fonte: "a..b" } }), no({}), {
      fetch,
      gravarCampos: semCampos,
    });
    expect(r.desfecho).toEqual({ ok: true });
    expect(chamadas[0]!.url).toBe("https://api.exemplo.com/v1/a..b");
  });

  it("4a. passou de 120 chamadas por minuto na organização: sai por Falhou sem chamar a rede", async () => {
    const { admin } = bancoDuble([
      {
        id: CHAVE_ID,
        organization_id: "aaaaaaaa-0000-4000-8000-0000000000ff",
        valor_cifrado: "\\xcifrado",
      },
    ]);
    const { fetch } = fetchQueResponde({ campaign: { name: "x" } });
    const ctx = { ...contexto(admin), org: "aaaaaaaa-0000-4000-8000-0000000000ff" };
    for (let i = 0; i < 120; i++) {
      expect(
        (await executarHttp(ctx, no({}), { fetch, gravarCampos: semCampos })).desfecho,
      ).toEqual({ ok: true });
    }
    const r = await executarHttp(ctx, no({}), { fetch, gravarCampos: semCampos });
    expect(r.desfecho).toEqual({ ok: false, erro: "http_limite_atingido" });
    expect(fetch).toHaveBeenCalledTimes(120);
  });

  it("5. o detalhe guarda o caminho do MODELO, nunca o valor preenchido", async () => {
    const { admin } = bancoDuble(linhas);
    const { fetch } = fetchQueResponde({ campaign: { name: "x" } });
    const r = await executarHttp(
      contexto(admin, {}, { gatilho: { fonte: "cpf-12345678900" } }),
      no({}),
      { fetch, gravarCampos: semCampos },
    );
    expect(r.detalhes?.[0]).toMatchObject({
      caminho: "/v1/{{gatilho.fonte}}",
      host: "api.exemplo.com",
    });
    expect(JSON.stringify(r.detalhes)).not.toContain("12345678900");
  });
});
