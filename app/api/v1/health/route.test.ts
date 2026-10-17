import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health — a rota é PÚBLICA e não pode publicar o endereço interno.
 *
 * O campo `target` (protocolo + host + porta) já era escondido de propósito: só
 * sai com `?verbose=1` mais o segredo interno, porque o endereço dos serviços
 * externos de uma instalação é superfície de ataque. O `error`, ao lado dele,
 * saía cru — e carrega o MESMO endereço quando o `.env` está numa das formas
 * erradas mais comuns do self-host.
 *
 * A condição de alcance existe porque, das três variáveis de endereço que a
 * rota consulta, só a do banco é validada como URL (`lib/env.ts:69`, `.url()`);
 * as outras duas (`lib/env.ts:140` e `155`) são `required()` puro. Um valor sem
 * esquema, ou com as aspas do `.env` sobrando, passa pelo Zod e explode no
 * `fetch` com o host dentro da mensagem:
 *
 *   "servico-interno.vps-do-cliente.com"
 *     -> "Failed to parse URL from servico-interno.vps-do-cliente.com"
 *
 * ESCOPO, dito em voz alta: isto vigia a SAÍDA da rota, não a validação do env.
 * Um endereço com esquema válido e host inalcançável devolve `"fetch failed"` e
 * guarda o host em `e.cause`, que a rota nunca devolveu — esse caso nunca vazou,
 * e este arquivo não o cobre porque não há o que cobrir.
 *
 * Um cuidado de forma: este arquivo exercita SÓ o caminho da fila, e não o do
 * outro serviço externo, porque nomeá-lo aqui reprovaria `lint:channels`
 * (doutrina restrição-de-canal, invariante 1 — gate obrigatório). A perda é
 * nenhuma: o vazamento é do `error` em `semAlvo()`, que é o mesmo código para os
 * três checks; um caminho basta para prová-lo, e a asserção é sobre o corpo
 * inteiro, não sobre um campo.
 *
 * Achado por @prevprocesso-maker no PR #465.
 */

/**
 * Sem esquema de propósito: é esta forma que faz o `fetch` do Node embutir o
 * endereço na mensagem, e é a forma que um `.env` mal preenchido produz.
 */
const HOST_VAZADO = "servico-interno.vps-do-cliente.com";
const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    UPSTASH_REDIS_REST_URL: "servico-interno.vps-do-cliente.com",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));

function pedido(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://crm.exemplo.com.br/api/v1/health${query}`, { headers });
}

describe("GET /api/v1/health — o endereço interno não sai para quem não tem o segredo", () => {
  beforeEach(() => vi.resetModules());

  it("não publica o host numa resposta anônima, nem pelo error", async () => {
    const { GET } = await import("./route");
    const corpo = JSON.stringify(await (await GET(pedido())).json());

    // A asserção é sobre o CORPO INTEIRO, não sobre um campo: se amanhã alguém
    // acrescentar outro lugar por onde o endereço saia, este caso reprova.
    expect(corpo).not.toContain(HOST_VAZADO);
    expect(corpo).not.toContain("Failed to parse URL");
  });

  it("mantém o diagnóstico útil — o motivo continua saindo", async () => {
    const { GET } = await import("./route");
    const { data } = await (await GET(pedido())).json();

    // Redigir não pode virar apagar: quem monitora de fora precisa seguir
    // distinguindo "não alcancei" de "fui barrado". Sem isto, a redação seria
    // uma regressão de observabilidade disfarçada de conserto.
    expect(data.checks.redis.reason).toBeTruthy();
    expect(data.checks.redis.status).toBe("down");
  });

  it("devolve o texto original a quem tem o segredo interno", async () => {
    const { GET } = await import("./route");
    const req = pedido("?verbose=1", { authorization: `Bearer ${SEGREDO}` });
    const corpo = JSON.stringify(await (await GET(req)).json());

    // O outro lado da mesma moeda: se a redação passasse a valer também no modo
    // verboso, o operador perderia o diagnóstico e ninguém notaria — o caso
    // acima ficaria verde do mesmo jeito.
    expect(corpo).toContain(HOST_VAZADO);
  });
});

/**
 * Worker e scheduler aparecem em `checks` (migration 0961), mas NÃO mexem no
 * status geral nem no HTTP: o `update.sh` e o deploy esperam `healthy` / 200 daqui,
 * e os dois serviços acabam de reiniciar num deploy, sem batimento novo ainda.
 * O alarme deles é das rotas /health/worker e /health/scheduler.
 */
describe("GET /api/v1/health — worker e scheduler entram em checks sem derrubar o status geral", () => {
  let batimentos: Record<string, string | undefined>;

  beforeEach(() => {
    vi.resetModules();
    batimentos = {};
    vi.doMock("@/lib/env", () => ({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "http://supabase.teste:54321",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
        SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
        UPSTASH_REDIS_REST_URL: "http://redis.teste:8090",
        UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
        INTERNAL_CRON_SECRET: SEGREDO,
        INTERNAL_SECRET: "",
      },
    }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => ({
          select: () => ({
            eq: (_c: string, servico: string) => ({
              maybeSingle: async () => ({
                data: batimentos[servico] ? { ultimo_em: batimentos[servico] } : null,
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    // Supabase e Redis respondem 200 (o canal de WhatsApp está sem configuração, então o geral base é
    // "degraded"): o que sobra de diferença entre os casos é só o batimento.
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/supabase/admin");
  });

  const ha = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  it("batimentos recentes: os dois ok em checks, geral 200", async () => {
    batimentos = { worker: ha(10), scheduler: ha(10) };
    const { GET } = await import("./route");
    const res = await GET(pedido());
    const { data } = await res.json();
    expect(data.checks.worker.status).toBe("ok");
    expect(data.checks.scheduler.status).toBe("ok");
    expect(data.checks.supabase.status).toBe("ok");
    expect(data.checks.redis.status).toBe("ok");
    expect(data.status).toBe("degraded"); // só por causa do canal sem configuração
    expect(res.status).toBe(200);
  });

  it("worker parado e scheduler sem linha: degraded em checks, mas o geral e o HTTP são idênticos ao caso saudável", async () => {
    batimentos = { worker: ha(10), scheduler: ha(10) };
    const { GET: saudavel } = await import("./route");
    const base = await (await saudavel(pedido())).json();

    vi.resetModules();
    batimentos = { worker: ha(900) };
    const { GET } = await import("./route");
    const res = await GET(pedido());
    const { data } = await res.json();
    expect(data.checks.worker).toMatchObject({ status: "degraded", reason: "batimento_atrasado" });
    expect(data.checks.scheduler).toMatchObject({ status: "degraded", reason: "sem_batimento" });
    // As dependências de antes mandam sozinhas no status geral.
    expect(data.status).toBe(base.data.status);
    expect(data.status).not.toBe("unhealthy");
    expect(res.status).toBe(200);
  });

  it("controle: dependência de antes caída continua tornando o geral unhealthy/503", async () => {
    batimentos = { worker: ha(10), scheduler: ha(10) };
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const { GET } = await import("./route");
    const res = await GET(pedido());
    expect(res.status).toBe(503);
    expect((await res.json()).data.status).toBe("unhealthy");
  });
});
