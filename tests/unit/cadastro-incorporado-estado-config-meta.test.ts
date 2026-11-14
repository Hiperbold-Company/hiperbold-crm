/**
 * Cadastro Incorporado do WhatsApp (migration 1014): as três peças puras da volta.
 *
 *  - o `state` (ida e volta, adulterado, vencido, e o isolamento de DOMÍNIO: um
 *    state do canal social não vale aqui, e um daqui não vale lá);
 *  - a configuração (banco > `.env`, vazio = ausente, sem App Secret = `null`);
 *  - a conversa com a Meta (troca sem `redirect_uri`, com o segredo no CORPO e
 *    nunca na URL; `debug_token` com o token do app no header; a WABA do navegador
 *    fora dos alvos do token é recusada).
 */
import { describe, expect, it, vi } from "vitest";

import { resolverConfigDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado/config";
import {
  emitirEstadoDoCadastroIncorporado,
  VALIDADE_DO_ESTADO_DO_CADASTRO_MS,
  verificarEstadoDoCadastroIncorporado,
} from "@/lib/channels/meta/cadastro-incorporado/estado";
import {
  escolherWaba,
  MENSAGEM_CODIGO_VENCIDO,
  motivoDaFalhaDaMeta,
  trocarCodigo,
  wabaDoToken,
} from "@/lib/channels/meta/cadastro-incorporado/meta";
import { emitirEstadoMetaSocial, verificarEstadoMetaSocial } from "@/lib/channels/meta-social/estado";

const SEGREDO = "segredo-interno-de-teste-com-32-caracteres";
const AGORA = new Date("2026-11-14T12:00:00Z");
const DADOS = { organizationId: "org-a", userId: "user-a", authSessionId: "sessao-a" };

describe("state do Cadastro Incorporado", () => {
  it("ida e volta devolve organização, usuário, sessão e nonce", () => {
    const state = emitirEstadoDoCadastroIncorporado(DADOS, { segredo: SEGREDO, agora: AGORA, nonce: "n1" });
    const lido = verificarEstadoDoCadastroIncorporado(state, { segredo: SEGREDO, agora: AGORA });
    expect(lido).toMatchObject({ ...DADOS, nonce: "n1" });
    // A carga é CIFRADA: nada dela aparece no texto do state.
    expect(state).not.toContain("org-a");
    expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain("org-a");
  });

  it("state adulterado (um caractere trocado) é recusado", () => {
    const state = emitirEstadoDoCadastroIncorporado(DADOS, { segredo: SEGREDO, agora: AGORA });
    const meio = Math.floor(state.length / 2);
    const trocado = state.slice(0, meio) + (state[meio] === "A" ? "B" : "A") + state.slice(meio + 1);
    expect(verificarEstadoDoCadastroIncorporado(trocado, { segredo: SEGREDO, agora: AGORA })).toBeNull();
    expect(verificarEstadoDoCadastroIncorporado("lixo", { segredo: SEGREDO, agora: AGORA })).toBeNull();
    expect(verificarEstadoDoCadastroIncorporado(state, { segredo: `${SEGREDO}-outro`, agora: AGORA })).toBeNull();
  });

  it("vale 15 minutos, e nem um milissegundo a mais", () => {
    expect(VALIDADE_DO_ESTADO_DO_CADASTRO_MS).toBe(15 * 60 * 1000);
    const state = emitirEstadoDoCadastroIncorporado(DADOS, { segredo: SEGREDO, agora: AGORA });
    const noLimite = new Date(AGORA.getTime() + VALIDADE_DO_ESTADO_DO_CADASTRO_MS);
    const depois = new Date(noLimite.getTime() + 1);
    expect(verificarEstadoDoCadastroIncorporado(state, { segredo: SEGREDO, agora: noLimite })).not.toBeNull();
    expect(verificarEstadoDoCadastroIncorporado(state, { segredo: SEGREDO, agora: depois })).toBeNull();
  });

  it("⭐ um state do canal social (Instagram/Messenger) não decifra aqui, e vice-versa", () => {
    for (const plataforma of ["instagram", "messenger"] as const) {
      const social = emitirEstadoMetaSocial(
        { plataforma, organizationId: "org-a", userId: "user-a" },
        { segredo: SEGREDO, agora: AGORA },
      );
      expect(verificarEstadoMetaSocial(social, { segredo: SEGREDO, agora: AGORA, plataforma })).not.toBeNull();
      expect(verificarEstadoDoCadastroIncorporado(social, { segredo: SEGREDO, agora: AGORA })).toBeNull();

      const daqui = emitirEstadoDoCadastroIncorporado(DADOS, { segredo: SEGREDO, agora: AGORA });
      expect(verificarEstadoMetaSocial(daqui, { segredo: SEGREDO, agora: AGORA, plataforma })).toBeNull();
    }
  });
});

describe("configuração do Cadastro Incorporado", () => {
  const ENV = { META_APP_ID: "app-do-env", META_WHATSAPP_CONFIG_ID: "cfg-do-env" };

  it("banco vence o .env, campo a campo", () => {
    expect(
      resolverConfigDoCadastroIncorporado({ app_id: "app-do-banco", whatsapp_config_id: "cfg-do-banco" }, "chave", ENV),
    ).toEqual({ appId: "app-do-banco", appSecret: "chave", configId: "cfg-do-banco" });
    expect(resolverConfigDoCadastroIncorporado({ app_id: "app-do-banco", whatsapp_config_id: null }, "chave", ENV)).toEqual(
      { appId: "app-do-banco", appSecret: "chave", configId: "cfg-do-env" },
    );
    expect(resolverConfigDoCadastroIncorporado(null, "chave", ENV)).toEqual({
      appId: "app-do-env",
      appSecret: "chave",
      configId: "cfg-do-env",
    });
  });

  it("vazio conta como ausente: banco em branco cai no .env; tudo em branco = null", () => {
    expect(resolverConfigDoCadastroIncorporado({ app_id: "  ", whatsapp_config_id: "" }, "chave", ENV)).toMatchObject({
      appId: "app-do-env",
      configId: "cfg-do-env",
    });
    expect(resolverConfigDoCadastroIncorporado({ app_id: "a", whatsapp_config_id: " " }, "chave", {})).toBeNull();
    expect(resolverConfigDoCadastroIncorporado(null, "chave", {})).toBeNull();
  });

  it("sem App Secret não há como trocar o código: null", () => {
    expect(resolverConfigDoCadastroIncorporado(null, null, ENV)).toBeNull();
    expect(resolverConfigDoCadastroIncorporado(null, "   ", ENV)).toBeNull();
  });
});

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

const APP = { appId: "123456", appSecret: "SEGREDO-DO-APP" };

describe("conversa com a Meta", () => {
  it("⭐ a troca vai por POST, SEM redirect_uri, com o segredo no corpo e nunca na URL", async () => {
    const fetcher = vi.fn(async () => respostaJson(200, { access_token: "TOKEN-DO-CLIENTE" }));
    const token = await trocarCodigo(APP, "codigo-do-fb-login", fetcher as unknown as typeof fetch);
    expect(token).toBe("TOKEN-DO-CLIENTE");

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/oauth\/access_token$/);
    expect(url).not.toContain("SEGREDO-DO-APP");
    expect(init.method).toBe("POST");
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get("client_id")).toBe("123456");
    expect(corpo.get("client_secret")).toBe("SEGREDO-DO-APP");
    expect(corpo.get("code")).toBe("codigo-do-fb-login");
    expect(corpo.has("redirect_uri")).toBe(false);
  });

  it("debug_token: token do app no header e a WABA única dos alvos de whatsapp_business_management", async () => {
    const fetcher = vi.fn(async () =>
      respostaJson(200, {
        data: {
          granular_scopes: [
            { scope: "whatsapp_business_messaging", target_ids: ["555555555"] },
            { scope: "whatsapp_business_management", target_ids: ["987654321"] },
          ],
        },
      }),
    );
    const alvos = await wabaDoToken(APP, "TOKEN-DO-CLIENTE", fetcher as unknown as typeof fetch);
    expect(alvos).toEqual(["987654321"]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("SEGREDO-DO-APP");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer 123456|SEGREDO-DO-APP");
    expect(escolherWaba(alvos, undefined)).toEqual({ ok: true, wabaId: "987654321" });
  });

  it("⭐ a WABA do navegador fora dos alvos do token é recusada", () => {
    expect(escolherWaba(["987654321"], "111111111")).toEqual({ ok: false, erro: "waba_nao_autorizada" });
    expect(escolherWaba(["987654321"], "987654321")).toEqual({ ok: true, wabaId: "987654321" });
    // Sem alvos, vale a do navegador (a validação com o token confere depois).
    expect(escolherWaba([], "111111111")).toEqual({ ok: true, wabaId: "111111111" });
    // Sem a do navegador: zero ou várias = indefinida.
    expect(escolherWaba([], undefined)).toEqual({ ok: false, erro: "waba_indefinida" });
    expect(escolherWaba(["1111111", "2222222"], undefined)).toEqual({ ok: false, erro: "waba_indefinida" });
  });

  it("código vencido ou já usado vira mensagem legível, sem o texto cru da Meta", async () => {
    const fetcher = vi.fn(async () =>
      respostaJson(400, { error: { code: 100, message: "This authorization code has expired. SEGREDO-CRU" } }),
    );
    const erro = await trocarCodigo(APP, "codigo-velho-xx", fetcher as unknown as typeof fetch).catch((e: unknown) => e);
    const motivo = motivoDaFalhaDaMeta(erro);
    expect(motivo).toEqual({ codigo: "codigo_vencido", mensagem: MENSAGEM_CODIGO_VENCIDO });
    expect(JSON.stringify(motivo)).not.toContain("SEGREDO-CRU");
  });
});
