/**
 * As rotas do Cadastro Incorporado do WhatsApp (migration 1014) e o 23505 do
 * número na rota manual.
 *
 * Rodam DE VERDADE: o state (cifra real), a troca do código e o `debug_token`
 * (`fetch` dublê respondendo como a Meta), a escolha da WABA e o caminho comum
 * `conectarCanalOficial`. Dublês só no banco, nas guardas, na cifra do token, na
 * validação da credencial e no registro do webhook. O que se prova:
 *
 *  - ⭐ isolamento entre duas organizações: state emitido para a org A usado numa
 *    sessão da org B é 403, sem troca de código e sem gravar nada;
 *  - replay (nonce já queimado) é 403 sem chegar à Meta;
 *  - o número ativo em outra organização é 409 `numero_em_outra_organizacao`,
 *    nas DUAS rotas;
 *  - o sucesso grava o token CIFRADO e audita sem token;
 *  - suporte em leitura é recusado antes de qualquer efeito.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  SEGREDO: "segredo-interno-de-teste-com-32-caracteres",
  sessao: { orgId: "org-a", userId: "user-a", authSessionId: "11111111-1111-4111-8111-111111111111" as string | null },
  suporteNegado: false,
  cfg: { appId: "123456", appSecret: "SEGREDO-DO-APP", configId: "cfg-1" } as null | {
    appId: string;
    appSecret: string;
    configId: string;
  },
  banco: {
    existente: null as null | Record<string, unknown>,
    erroDaBusca: null as null | { code: string; message: string },
    erroDoNonce: null as null | { code: string; message?: string },
    erroDoInsert: null as null | { code: string; message: string },
    inserts: [] as Array<{ tabela: string; linha: Record<string, unknown> }>,
  },
  validacaoRecusada: null as null | string,
  audit: [] as Array<Record<string, unknown>>,
  cifrar: [] as string[],
}));

vi.mock("@/lib/env", async (original) => {
  const m = (await original()) as { env: Record<string, unknown> };
  return {
    ...m,
    env: new Proxy(m.env, { get: (alvo, chave) => (chave === "INTERNAL_SECRET" ? h.SEGREDO : Reflect.get(alvo, chave)) }),
  };
});
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    h.suporteNegado
      ? new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 })
      : null,
  authenticatedSessionId: async () => {
    if (!h.sessao.authSessionId) throw new Error("Sessão ausente.");
    return h.sessao.authSessionId;
  },
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: h.sessao.userId, idioma: "pt-BR", is_platform_admin: false, support: null },
    org: { orgId: h.sessao.orgId, role: "manager" },
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    h.audit.push(entrada);
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/channels/meta/cadastro-incorporado/config", () => ({
  configDoCadastroIncorporado: async () => h.cfg,
  invalidarConfigDoCadastroIncorporado: () => undefined,
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_admin: unknown, valor: string) => {
    h.cifrar.push(valor);
    return `CIFRADO#${h.cifrar.length}`;
  },
}));
vi.mock("@/lib/webhooks/url-publica", () => ({ basePublicaDoWebhookMeta: () => "https://crm.exemplo.com" }));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: async () =>
    h.validacaoRecusada
      ? { ok: false, motivo: h.validacaoRecusada }
      : {
          ok: true,
          displayPhoneNumber: "+55 11 99999-0000",
          verifiedName: "Loja Exemplo",
          qualityRating: "GREEN",
        },
}));
vi.mock("@/lib/channels/meta/webhook-da-sessao", async (original) => ({
  ...((await original()) as object),
  registrarWebhookDaSessao: async () => ({ registrado: true, url: "https://crm.exemplo.com/x", erro: null, em: "agora" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      for (const n of ["select", "eq", "is"]) q[n] = () => q;
      q.maybeSingle = async () => ({
        data: h.banco.erroDaBusca ? null : h.banco.existente,
        error: h.banco.erroDaBusca,
      });
      q.insert = (linha: Record<string, unknown>) => {
        h.banco.inserts.push({ tabela, linha });
        if (tabela === "calendar_oauth_nonces") return Promise.resolve({ error: h.banco.erroDoNonce });
        return {
          select: () => ({
            maybeSingle: async () =>
              h.banco.erroDoInsert
                ? { data: null, error: h.banco.erroDoInsert }
                : { data: { id: "sessao-1", webhook_path_token: "ptk" }, error: null },
          }),
        };
      };
      return q;
    },
  }),
}));

import { logger } from "@/lib/logger";
import { emitirEstadoDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado/estado";
import { GET, POST } from "@/app/api/v1/channels/official/cadastro-incorporado/route";
import { POST as POST_MANUAL } from "@/app/api/v1/channels/official/route";

const NUMERO = "111222333444";
const WABA = "999888777666";
const TOKEN_CLARO = "TOKEN-CLARO-DA-META-abcdefghijklmnop";
const ERRO_DO_INDICE = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "channel_sessions_meta_phone_number_id_ativo_unique"',
};

const fetchMock = vi.fn();
const chamadasAMeta = () => fetchMock.mock.calls.map((c) => String(c[0]));

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

function metaResponde() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/oauth/access_token")) return respostaJson(200, { access_token: TOKEN_CLARO });
    if (url.includes("/debug_token")) {
      return respostaJson(200, {
        data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }] },
      });
    }
    return respostaJson(200, { status: "PENDING", display_phone_number: "+55 11 99999-0000" });
  });
}

function stateDe(dados: { organizationId: string; userId: string; authSessionId?: string }) {
  return emitirEstadoDoCadastroIncorporado(dados, { segredo: h.SEGREDO, agora: new Date() });
}

const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/channels/official/cadastro-incorporado", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

const corpoValido = (extra: Record<string, unknown> = {}) => ({
  state: stateDe({ organizationId: "org-a", userId: "user-a", authSessionId: h.sessao.authSessionId ?? undefined }),
  code: "codigo-do-fb-login-123",
  phone_number_id: NUMERO,
  ...extra,
});

const insertsDeCanal = () => h.banco.inserts.filter((i) => i.tabela === "channel_sessions");

beforeEach(() => {
  h.sessao.orgId = "org-a";
  h.sessao.userId = "user-a";
  h.sessao.authSessionId = "11111111-1111-4111-8111-111111111111";
  h.suporteNegado = false;
  h.cfg = { appId: "123456", appSecret: "SEGREDO-DO-APP", configId: "cfg-1" };
  h.banco.existente = null;
  h.banco.erroDaBusca = null;
  h.validacaoRecusada = null;
  vi.mocked(logger.warn).mockClear();
  h.banco.erroDoNonce = null;
  h.banco.erroDoInsert = null;
  h.banco.inserts.length = 0;
  h.audit.length = 0;
  h.cifrar.length = 0;
  fetchMock.mockReset();
  metaResponde();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /api/v1/channels/official/cadastro-incorporado", () => {
  it("configurado: devolve appId, configId, versão e um state desta org e deste usuário, sem cache", async () => {
    const res = await GET();
    const corpo = await res.json();
    expect(corpo.data).toMatchObject({ disponivel: true, appId: "123456", configId: "cfg-1" });
    expect(corpo.data.versaoDaGraph).toMatch(/^v\d+\.\d+$/);
    expect(typeof corpo.data.state).toBe("string");
    expect(JSON.stringify(corpo)).not.toContain("SEGREDO-DO-APP");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);

    // O state emitido CONCLUI na mesma sessão.
    const fim = await POST(post({ state: corpo.data.state, code: "codigo-do-fb-login-123", phone_number_id: NUMERO }));
    expect(fim.status).toBe(200);
  });

  it("sem sessão de login: o state sai sem sessão, e isso fica no log com request_id", async () => {
    h.sessao.authSessionId = null;
    const res = await GET();
    expect((await res.json()).data.disponivel).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("state emitido sem sessão de login"),
      expect.objectContaining({ request_id: expect.any(String) }),
    );
  });

  it("sem configuração: disponivel false com motivo nao_configurado", async () => {
    h.cfg = null;
    const corpo = await (await GET()).json();
    expect(corpo.data).toEqual({ disponivel: false, motivo: "nao_configurado" });
  });
});

describe("POST /api/v1/channels/official/cadastro-incorporado", () => {
  it("⭐ isolamento: state da org A numa sessão da org B é 403, sem troca de código e sem gravar nada", async () => {
    const corpo = corpoValido();
    h.sessao.orgId = "org-b";
    h.sessao.userId = "user-b";
    const res = await POST(post(corpo));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("estado_invalido");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.banco.inserts).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("⭐ isolamento: mesmo usuário trocando para a org B também é 403 (a org vem só da sessão)", async () => {
    const corpo = corpoValido({ organization_id: "org-b" });
    h.sessao.orgId = "org-b";
    const res = await POST(post(corpo));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.banco.inserts).toEqual([]);
  });

  it("state de outra sessão de login do mesmo usuário é 403", async () => {
    const corpo = corpoValido();
    h.sessao.authSessionId = "22222222-2222-4222-8222-222222222222";
    expect((await POST(post(corpo))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ replay: nonce já queimado (23505) é 403 sem chegar à Meta", async () => {
    h.banco.erroDoNonce = { code: "23505" };
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("estado_invalido");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertsDeCanal()).toEqual([]);
  });

  it("⭐ recusas de segurança vão ao log com org, usuário e código, e nunca com state, code ou token", async () => {
    const corpo = corpoValido();
    h.sessao.orgId = "org-b";
    h.sessao.userId = "user-b";
    await POST(post(corpo));
    h.sessao.orgId = "org-a";
    h.sessao.userId = "user-a";
    h.banco.erroDoNonce = { code: "23505" };
    await POST(post(corpoValido()));
    h.banco.erroDoNonce = null;
    h.banco.erroDoInsert = ERRO_DO_INDICE;
    await POST(post(corpoValido()));

    const chamadas = vi.mocked(logger.warn).mock.calls.filter(([m]) => String(m).includes("recusa de segurança"));
    expect(chamadas.map(([, ctx]) => (ctx as Record<string, unknown>).recusa)).toEqual([
      "estado_de_outra_organizacao_ou_usuario",
      "nonce_repetido",
      "numero_em_outra_organizacao",
    ]);
    expect(chamadas[0]![1]).toMatchObject({ request_id: expect.any(String), organization_id: "org-b", user_id: "user-b" });
    const log = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(log).not.toContain(corpo.state);
    expect(log).not.toContain("codigo-do-fb-login-123");
    expect(log).not.toContain(TOKEN_CLARO);
  });

  it("⭐ busca da conexão existente que falha é 500 e não segue para o INSERT", async () => {
    h.banco.erroDaBusca = { code: "57014", message: "canceling statement due to statement timeout" };
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(500);
    expect(insertsDeCanal()).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("⭐ credencial recusada pela Meta: 422 com frase fixa, sem o texto cru, que fica só no log", async () => {
    const CRU = "Unsupported post request. Object with ID '111222333444' does not exist (#100)";
    h.validacaoRecusada = CRU;
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.message).toMatch(/A Meta recusou a credencial do número escolhido/);
    expect(JSON.stringify(corpo)).not.toContain(CRU);
    expect(insertsDeCanal()).toEqual([]);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain(CRU);
  });

  it("outro erro ao queimar o nonce é 500, também sem chegar à Meta", async () => {
    h.banco.erroDoNonce = { code: "57014", message: "timeout" };
    expect((await POST(post(corpoValido()))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ número ativo em outra organização (23505 do índice global) é 409 numero_em_outra_organizacao", async () => {
    h.banco.erroDoInsert = ERRO_DO_INDICE;
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("numero_em_outra_organizacao");
    expect(corpo.error.message).toMatch(/outra organização desta instalação/);
    expect(h.audit).toEqual([]);
  });

  it("⭐ sucesso: grava o token CIFRADO (nunca o claro) e audita sem token", async () => {
    const res = await POST(post(corpoValido({ nome: "  Atendimento  " })));
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toMatchObject({ connected: true, displayName: "Atendimento", precisaRegistrar: true });

    // Ordem: nonce queimado, troca do código, debug_token.
    const nonceAntes = h.banco.inserts.findIndex((i) => i.tabela === "calendar_oauth_nonces");
    expect(nonceAntes).toBe(0);
    expect(chamadasAMeta()[0]).toContain("/oauth/access_token");
    expect(chamadasAMeta()[1]).toContain("/debug_token");

    expect(h.cifrar).toEqual([TOKEN_CLARO]);
    const [canal] = insertsDeCanal();
    expect(canal!.linha).toMatchObject({
      organization_id: "org-a",
      meta_phone_number_id: NUMERO,
      meta_waba_id: WABA,
      meta_token_encrypted: "CIFRADO#1",
      webhook_secret_encrypted: "CIFRADO#1",
    });
    expect(JSON.stringify(h.banco.inserts)).not.toContain(TOKEN_CLARO);

    const auditoria = h.audit.find((a) => a.action === "channel.official_connected");
    expect(auditoria).toMatchObject({
      organizationId: "org-a",
      actorUserId: "user-a",
      resourceType: "channel_session",
      resourceId: "sessao-1",
      metadata: { origem: "cadastro_incorporado", phone_number_id: NUMERO, waba_id: WABA },
    });
    expect(JSON.stringify(h.audit)).not.toContain(TOKEN_CLARO);
    expect(JSON.stringify(corpo)).not.toContain(TOKEN_CLARO);
  });

  it("WABA do navegador fora das autorizadas pelo token é recusada antes de gravar", async () => {
    const res = await POST(post(corpoValido({ waba_id: "123123123" })));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("waba_nao_autorizada");
    expect(insertsDeCanal()).toEqual([]);
  });

  it("código vencido: 422 com a mensagem legível e nada gravado", async () => {
    fetchMock.mockImplementation(async () =>
      respostaJson(400, { error: { code: 100, message: "This authorization code has been used." } }),
    );
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("codigo_vencido");
    expect(corpo.error.message).toMatch(/30 segundos/);
    expect(insertsDeCanal()).toEqual([]);
  });

  it("FINISH_ONLY_WABA sem número: 422 pedindo para escolher o número, sem efeito", async () => {
    const { phone_number_id: _semNumero, ...corpo } = corpoValido({ evento: "FINISH_ONLY_WABA" });
    const res = await POST(post(corpo));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("Escolha um número no cadastro da Meta");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.banco.inserts).toEqual([]);
  });

  it("sem configuração: 422 nao_configurado, sem queimar nonce nem chamar a Meta", async () => {
    h.cfg = null;
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("nao_configurado");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ suporte em leitura: recusado antes de qualquer efeito", async () => {
    h.suporteNegado = true;
    const res = await POST(post(corpoValido()));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.banco.inserts).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("corpo inválido (code com espaço, número com letra) é 422 sem efeito", async () => {
    expect((await POST(post(corpoValido({ code: "tem espaço aqui" })))).status).toBe(422);
    expect((await POST(post(corpoValido({ phone_number_id: "12ab45" })))).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.banco.inserts).toEqual([]);
  });
});

describe("POST /api/v1/channels/official (manual): o mesmo número em outra organização", () => {
  const manual = () =>
    new NextRequest("http://localhost/api/v1/channels/official", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number_id: NUMERO, waba_id: WABA, token: TOKEN_CLARO }),
    });

  it("⭐ 23505 do índice global do número é 409 numero_em_outra_organizacao (antes era 500)", async () => {
    h.banco.erroDoInsert = ERRO_DO_INDICE;
    const res = await POST_MANUAL(manual());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("numero_em_outra_organizacao");
  });

  it("credencial recusada na porta manual segue devolvendo o motivo da Meta ao operador", async () => {
    h.validacaoRecusada = "o número 111222333444 não pertence à WABA 999888777666";
    const res = await POST_MANUAL(manual());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe(h.validacaoRecusada);
  });

  it("23505 de OUTRA trava (a de dentro da organização) segue no 500 genérico", async () => {
    h.banco.erroDoInsert = { code: "23505", message: 'duplicate key value violates unique constraint "outra_trava"' };
    expect((await POST_MANUAL(manual())).status).toBe(500);
  });

  it("sucesso manual audita channel.official_connected com origem manual e sem token", async () => {
    const res = await POST_MANUAL(manual());
    expect(res.status).toBe(200);
    expect(h.audit.find((a) => a.action === "channel.official_connected")).toMatchObject({
      metadata: { origem: "manual", phone_number_id: NUMERO, waba_id: WABA },
    });
    expect(JSON.stringify(h.audit)).not.toContain(TOKEN_CLARO);
  });
});
