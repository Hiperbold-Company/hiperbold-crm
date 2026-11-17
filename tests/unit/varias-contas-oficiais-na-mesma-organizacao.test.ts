/**
 * Várias contas oficiais do WhatsApp (WABA) na mesma organização — fase A, só servidor (17/11/2026).
 *
 * Decisão do dono do produto: a identidade da conexão oficial é o NÚMERO (`meta_phone_number_id`) dentro
 * da organização. Os casos medem o desfecho pelas rotas de verdade e pelo caso de uso de verdade
 * (`conectarCanalOficial`); dublê só no banco, na Meta (validação, registro do webhook), na cifra e nas
 * guardas de sessão:
 *
 *   (a) conectar um SEGUNDO número cria outra linha e não altera a primeira;
 *   (b) reconectar o MESMO número atualiza a mesma linha (troca de credencial);
 *   (c) `channel_session_id` de OUTRA organização → 404 em toda rota `official/*` e na de modelos, sem
 *       nada da outra organização na resposta;
 *   (d) a lista em cartões só traz a organização da sessão e nunca campo de credencial.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_WAHA, CHANNEL_PROVIDER_ZERNIO, CHANNEL_PROVIDER_META_SOCIAL } from "@/lib/channels/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";

const ORG_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ORG_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const SESSAO_DA_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const NUMERO_1 = "111111111111111";
const NUMERO_2 = "222222222222222";
const WABA_1 = "900000000000001";
const WABA_2 = "900000000000002";
const TOKEN = "EAA-token-de-teste-com-mais-de-vinte-caracteres";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "user-a", idioma: "pt-BR", support: false, is_platform_admin: false },
    org: { orgId: "0a0a0a0a-0000-4000-8000-00000000000a", role: "manager" },
  })),
}));
vi.mock("@/lib/api/auth-dual-admin", () => ({ autorizarAdministracao: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/webhooks/secrets", () => {
  let n = 0;
  return {
    encryptWebhookSecret: vi.fn(async () => `cifra-${++n}`),
    decryptWebhookSecret: vi.fn(async () => "token-decifrado"),
  };
});
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: vi.fn(async ({ phoneNumberId }: { phoneNumberId: string }) => ({
    ok: true,
    displayPhoneNumber: phoneNumberId === "111111111111111" ? "55 11 91111-1111" : "55 11 92222-2222",
    verifiedName: `Loja ${phoneNumberId.slice(0, 1)}`,
  })),
}));
vi.mock("@/lib/channels/meta/webhook-da-sessao", async (original) => ({
  ...((await original()) as object),
  registrarWebhookDaSessao: vi.fn(async () => ({ registrado: true, url: "https://crm.exemplo.com/x", erro: null, em: "agora" })),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: vi.fn(async () => ({ verifyToken: null })),
  appDaMetaDoAmbiente: vi.fn(() => ({ verifyToken: null })),
}));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn() }));

type Linha = Record<string, unknown>;

/**
 * Banco de mentira com o que as consultas destas rotas usam: filtros por igualdade, `order`, `limit`,
 * `maybeSingle`, `insert` e `update`. PROJETA as colunas do `select` — campo não pedido não sai.
 */
function makeDb(linhas: Linha[]) {
  const selects: string[] = [];
  let seq = 0;

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private ordens: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    private teto: number | null = null;
    private colunas: string | null = null;
    private unica = false;
    constructor(
      private readonly tabela: string,
      private readonly op: "select" | "insert" | "update",
      private readonly patch: Linha | null = null,
    ) {}
    select(cols?: string) {
      this.colunas = cols ?? "*";
      if (this.op === "select") selects.push(this.colunas);
      return this;
    }
    eq(c: string, v: unknown) {
      this.filtros.push([c, v]);
      return this;
    }
    is(c: string, v: unknown) {
      this.filtros.push([c, v]);
      return this;
    }
    in(c: string, v: unknown[]) {
      this.filtros.push([c, { in: v }]);
      return this;
    }
    order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      this.ordens.push({ col, asc: o.ascending !== false, nullsFirst: o.nullsFirst === true });
      return this;
    }
    limit(n: number) {
      this.teto = n;
      return this;
    }
    maybeSingle() {
      this.unica = true;
      return this;
    }
    private casam(): Linha[] {
      return linhas.filter(
        (l) =>
          l.__tabela === this.tabela &&
          this.filtros.every(([c, v]) =>
            v && typeof v === "object" && "in" in (v as object)
              ? ((v as { in: unknown[] }).in).includes(l[c])
              : (l[c] ?? null) === v,
          ),
      );
    }
    private projetar(l: Linha): Linha {
      if (!this.colunas || this.colunas === "*") return { ...l };
      const saida: Linha = {};
      for (const c of this.colunas.split(",").map((s) => s.trim())) if (c) saida[c] = l[c] ?? null;
      return saida;
    }
    private executar(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const nova: Linha = {
          __tabela: this.tabela,
          id: `cccccccc-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          webhook_path_token: `ptk-${seq}`,
          archived_at: null,
          created_at: `2026-11-17T00:00:0${seq}.000Z`,
          ...(this.patch ?? {}),
        };
        linhas.push(nova);
        return { data: this.colunas ? this.projetar(nova) : null, error: null };
      }
      if (this.op === "update") {
        const alvo = this.casam();
        for (const l of alvo) Object.assign(l, this.patch);
        return { data: null, error: null };
      }
      let r = this.casam();
      for (const o of [...this.ordens].reverse()) {
        r = [...r].sort((x, y) => {
          const a = x[o.col] ?? null;
          const b = y[o.col] ?? null;
          if (a === b) return 0;
          if (a === null) return o.nullsFirst ? -1 : 1;
          if (b === null) return o.nullsFirst ? 1 : -1;
          return (String(a) < String(b) ? -1 : 1) * (o.asc ? 1 : -1);
        });
      }
      if (this.teto !== null) r = r.slice(0, this.teto);
      if (this.unica) {
        if (r.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: r[0] ? this.projetar(r[0]) : null, error: null };
      }
      return { data: r.map((l) => this.projetar(l)), error: null };
    }
    then<R1 = unknown, R2 = never>(
      ok?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
      err?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(ok, err);
    }
  }

  const client = {
    from: (tabela: string) => ({
      select: (cols?: string) => new Q(tabela, "select").select(cols),
      insert: (patch: Linha) => new Q(tabela, "insert", patch),
      update: (patch: Linha) => new Q(tabela, "update", patch),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { linhas, selects, client };
}

function sessaoOficial(over: Linha = {}): Linha {
  return {
    __tabela: "channel_sessions",
    id: "aaaaaaaa-0000-4000-8000-0000000000a1",
    organization_id: ORG_A,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: NUMERO_1,
    meta_waba_id: WABA_1,
    meta_token_encrypted: "cifra-antiga",
    webhook_secret_encrypted: "segredo-cifrado",
    webhook_path_token: "ptk-a1",
    phone_number: "+5511911111111",
    display_name: "Loja 1",
    status: "WORKING",
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const conectar = (corpo: Linha) =>
  new NextRequest("https://crm.exemplo.com/api/v1/channels/official", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("(a) e (b) — a conexão oficial é o NÚMERO dentro da organização", () => {
  it("(a) conectar um segundo número cria OUTRA linha e não mexe na primeira", async () => {
    const primeira = sessaoOficial();
    const antes = { ...primeira };
    const db = makeDb([primeira]);
    const { POST } = await import("@/app/api/v1/channels/official/route");

    const res = await POST(conectar({ phone_number_id: NUMERO_2, waba_id: WABA_2, token: TOKEN }));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { channel_session_id: string; connected: boolean } };

    const oficiais = db.linhas.filter((l) => l.organization_id === ORG_A && l.provider === CHANNEL_PROVIDER_META);
    expect(oficiais).toHaveLength(2);
    expect(primeira).toEqual(antes);
    const segunda = oficiais.find((l) => l.meta_phone_number_id === NUMERO_2)!;
    expect(segunda.id).not.toBe(primeira.id);
    expect(segunda.meta_waba_id).toBe(WABA_2);
    expect(corpo.data.channel_session_id).toBe(segunda.id);
  });

  it("com duas oficiais, o GET sem id segue respondendo (a mais antiga), e com id mostra a pedida", async () => {
    const primeira = sessaoOficial();
    const segunda = sessaoOficial({
      id: "aaaaaaaa-0000-4000-8000-0000000000a2",
      meta_phone_number_id: NUMERO_2,
      meta_waba_id: WABA_2,
      display_name: "Loja 2",
      created_at: "2026-11-01T00:00:00.000Z",
    });
    makeDb([segunda, primeira]);
    const { GET } = await import("@/app/api/v1/channels/official/route");

    const semId = (await (await GET(new NextRequest("https://crm.exemplo.com/api/v1/channels/official"))).json()) as {
      data: { channel_session_id: string; connected: boolean };
    };
    expect(semId.data.connected).toBe(true);
    expect(semId.data.channel_session_id).toBe(primeira.id);

    const comId = (await (
      await GET(new NextRequest(`https://crm.exemplo.com/api/v1/channels/official?id=${segunda.id as string}`))
    ).json()) as { data: { channel_session_id: string; wabaId: string } };
    expect(comId.data.channel_session_id).toBe(segunda.id);
    expect(comId.data.wabaId).toBe(WABA_2);
  });

  it("(b) reconectar o MESMO número atualiza a mesma linha (troca de credencial), sem linha nova", async () => {
    const primeira = sessaoOficial({ meta_token_encrypted: "cifra-antiga" });
    const db = makeDb([primeira]);
    const { POST } = await import("@/app/api/v1/channels/official/route");

    const res = await POST(conectar({ phone_number_id: NUMERO_1, waba_id: WABA_1, token: TOKEN }));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { channel_session_id: string } };

    const oficiais = db.linhas.filter((l) => l.organization_id === ORG_A && l.provider === CHANNEL_PROVIDER_META);
    expect(oficiais).toHaveLength(1);
    expect(primeira.meta_token_encrypted).not.toBe("cifra-antiga");
    expect(corpo.data.channel_session_id).toBe(primeira.id);
  });

  it("(b) o mesmo número EXCLUÍDO volta à vida na mesma linha", async () => {
    const primeira = sessaoOficial({ archived_at: "2026-11-10T00:00:00.000Z", status: "STOPPED" });
    const db = makeDb([primeira]);
    const { POST } = await import("@/app/api/v1/channels/official/route");

    const res = await POST(conectar({ phone_number_id: NUMERO_1, waba_id: WABA_1, token: TOKEN }));
    expect(res.status).toBe(200);
    expect(db.linhas.filter((l) => l.provider === CHANNEL_PROVIDER_META)).toHaveLength(1);
    expect(primeira.archived_at).toBeNull();
    expect(primeira.status).toBe("WORKING");
  });

  it("com channel_session_id, o número tem de ser o da conexão (422) e nada é gravado", async () => {
    const primeira = sessaoOficial();
    const antes = { ...primeira };
    const db = makeDb([primeira]);
    const { POST } = await import("@/app/api/v1/channels/official/route");

    const res = await POST(
      conectar({ phone_number_id: NUMERO_2, waba_id: WABA_2, token: TOKEN, channel_session_id: primeira.id }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("numero_diferente_da_conexao");
    expect(db.linhas).toHaveLength(1);
    expect(primeira).toEqual(antes);
  });
});

describe("(c) channel_session_id de OUTRA organização → 404, sem vazar", () => {
  function bancoComAOutra() {
    return makeDb([
      sessaoOficial(),
      sessaoOficial({
        id: SESSAO_DA_B,
        organization_id: ORG_B,
        meta_phone_number_id: "333333333333333",
        meta_waba_id: "900000000000003",
        display_name: "Segredo da B",
        webhook_path_token: "ptk-da-b",
      }),
    ]);
  }

  async function esperar404(res: Response) {
    expect(res.status).toBe(404);
    const texto = await res.text();
    for (const vazamento of ["Segredo da B", "333333333333333", "900000000000003", "ptk-da-b", SESSAO_DA_B]) {
      expect(texto).not.toContain(vazamento);
    }
  }

  it("GET /official?id=", async () => {
    bancoComAOutra();
    const { GET } = await import("@/app/api/v1/channels/official/route");
    await esperar404(await GET(new NextRequest(`https://crm.exemplo.com/api/v1/channels/official?id=${SESSAO_DA_B}`)));
  });

  it("POST /official com channel_session_id — e nada é gravado", async () => {
    const db = bancoComAOutra();
    const { POST } = await import("@/app/api/v1/channels/official/route");
    await esperar404(
      await POST(conectar({ phone_number_id: "333333333333333", waba_id: WABA_1, token: TOKEN, channel_session_id: SESSAO_DA_B })),
    );
    expect(db.linhas).toHaveLength(2);
  });

  it("POST /official/webhook", async () => {
    bancoComAOutra();
    const { POST } = await import("@/app/api/v1/channels/official/webhook/route");
    await esperar404(
      await POST(
        new NextRequest("https://crm.exemplo.com/api/v1/channels/official/webhook", {
          method: "POST",
          body: JSON.stringify({ channel_session_id: SESSAO_DA_B }),
        }),
      ),
    );
  });

  it("GET /official/numero?id=", async () => {
    bancoComAOutra();
    const { GET } = await import("@/app/api/v1/channels/official/numero/route");
    await esperar404(await GET(new NextRequest(`https://crm.exemplo.com/api/v1/channels/official/numero?id=${SESSAO_DA_B}`)));
  });

  it("POST /official/registrar", async () => {
    bancoComAOutra();
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    await esperar404(
      await POST(
        new NextRequest("https://crm.exemplo.com/api/v1/channels/official/registrar", {
          method: "POST",
          body: JSON.stringify({ pin: "123456", channel_session_id: SESSAO_DA_B }),
        }),
      ),
    );
  });

  it("GET /channels/templates?channel_session_id=", async () => {
    bancoComAOutra();
    const { GET } = await import("@/app/api/v1/channels/templates/route");
    await esperar404(
      await GET(new NextRequest(`https://crm.exemplo.com/api/v1/channels/templates?channel_session_id=${SESSAO_DA_B}`)),
    );
  });

  it("POST /channels/templates?channel_session_id=", async () => {
    bancoComAOutra();
    const { POST } = await import("@/app/api/v1/channels/templates/route");
    await esperar404(
      await POST(
        new NextRequest(`https://crm.exemplo.com/api/v1/channels/templates?channel_session_id=${SESSAO_DA_B}`, {
          method: "POST",
          body: "{}",
        }),
      ),
    );
  });

  it("o id da PRÓPRIA organização passa (controle do 404)", async () => {
    bancoComAOutra();
    const { GET } = await import("@/app/api/v1/channels/official/route");
    const res = await GET(
      new NextRequest("https://crm.exemplo.com/api/v1/channels/official?id=aaaaaaaa-0000-4000-8000-0000000000a1"),
    );
    expect(res.status).toBe(200);
  });
});

describe("(d) GET /api/v1/channels/conexoes — cartões só da organização, sem credencial", () => {
  const CAMPOS_PROIBIDOS = [
    "meta_token_encrypted",
    "webhook_secret_encrypted",
    "webhook_path_token",
    "uazapi_token_encrypted",
    "zernio_token_encrypted",
    "meta_social_token_encrypted",
    "metadata",
    "token",
    "verify_token",
  ];

  function bancoDeConexoes() {
    return makeDb([
      sessaoOficial({ meta_webhook_override_uri: "https://crm.exemplo.com/x", meta_webhook_override_erro: null }),
      sessaoOficial({
        id: "aaaaaaaa-0000-4000-8000-0000000000a2",
        meta_phone_number_id: NUMERO_2,
        meta_waba_id: WABA_2,
        meta_webhook_override_erro: "recusado pela Meta",
        created_at: "2026-10-02T00:00:00.000Z",
      }),
      {
        __tabela: "channel_sessions",
        id: "aaaaaaaa-0000-4000-8000-0000000000a3",
        organization_id: ORG_A,
        provider: CHANNEL_PROVIDER_UAZAPI,
        uazapi_token_encrypted: "token-da-instancia",
        webhook_path_token: "ptk-a3",
        phone_number: "+5511933333333",
        display_name: "Vendas",
        status: "SCAN_QR_CODE",
        archived_at: null,
        created_at: "2026-10-03T00:00:00.000Z",
      },
      {
        __tabela: "channel_sessions",
        id: "aaaaaaaa-0000-4000-8000-0000000000a4",
        organization_id: ORG_A,
        provider: CHANNEL_PROVIDER_META_SOCIAL,
        meta_social_platform: "instagram",
        meta_social_username: "lojaexemplo",
        meta_social_token_encrypted: "token-do-instagram",
        display_name: "Instagram",
        status: "WORKING",
        archived_at: null,
        created_at: "2026-10-04T00:00:00.000Z",
      },
      {
        __tabela: "channel_sessions",
        id: "aaaaaaaa-0000-4000-8000-0000000000a5",
        organization_id: ORG_A,
        provider: CHANNEL_PROVIDER_ZERNIO,
        zernio_token_encrypted: "token-do-parceiro",
        display_name: "Parceiro",
        status: "FAILED",
        archived_at: null,
        created_at: "2026-10-05T00:00:00.000Z",
      },
      {
        __tabela: "channel_sessions",
        id: "aaaaaaaa-0000-4000-8000-0000000000a6",
        organization_id: ORG_A,
        provider: CHANNEL_PROVIDER_WAHA,
        display_name: "Excluída",
        status: "STOPPED",
        archived_at: "2026-11-01T00:00:00.000Z",
        created_at: "2026-10-06T00:00:00.000Z",
      },
      sessaoOficial({ id: SESSAO_DA_B, organization_id: ORG_B, display_name: "Segredo da B" }),
    ]);
  }

  it("devolve só as vivas da organização, com tipo, status normalizado e dados da oficial", async () => {
    const db = bancoDeConexoes();
    vi.mocked(autorizarAdministracao).mockResolvedValue({
      ok: true,
      supabase: db.client,
      organizationId: ORG_A,
    } as never);
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");
    const res = await GET(new NextRequest("https://crm.exemplo.com/api/v1/channels/conexoes"));
    expect(res.status).toBe(200);
    expect(vi.mocked(autorizarAdministracao).mock.calls[0]?.[1]).toMatchObject({ role: "manager", escrita: false });

    const texto = await res.text();
    const { data } = JSON.parse(texto) as { data: Array<Record<string, unknown>> };
    expect(data.map((c) => c.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-0000000000a1",
      "aaaaaaaa-0000-4000-8000-0000000000a2",
      "aaaaaaaa-0000-4000-8000-0000000000a3",
      "aaaaaaaa-0000-4000-8000-0000000000a4",
      "aaaaaaaa-0000-4000-8000-0000000000a5",
    ]);
    expect(texto).not.toContain("Segredo da B");
    expect(texto).not.toContain(SESSAO_DA_B);

    const [of1, of2, qr, ig, parceiro] = data;
    expect(of1).toMatchObject({
      tipo: "whatsapp_oficial",
      via: "meta",
      status: "conectado",
      status_bruto: "WORKING",
      oficial: { waba_id: WABA_1, meta_phone_number_id: NUMERO_1, webhook_registrado: true },
    });
    expect(of2).toMatchObject({ status: "precisa_atencao", oficial: { webhook_registrado: false } });
    expect(qr).toMatchObject({ tipo: "whatsapp_qr", status: "precisa_atencao", numero_ou_handle: "+5511933333333", oficial: null });
    expect(ig).toMatchObject({ tipo: "instagram", numero_ou_handle: "@lojaexemplo", status: "conectado" });
    expect(parceiro).toMatchObject({ tipo: "whatsapp_oficial", via: "parceiro", status: "desconectado" });
  });

  it("nenhum campo nem valor de credencial sai — nem na consulta, nem na resposta", async () => {
    const db = bancoDeConexoes();
    vi.mocked(autorizarAdministracao).mockResolvedValue({ ok: true, supabase: db.client, organizationId: ORG_A } as never);
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");
    const texto = await (await GET(new NextRequest("https://crm.exemplo.com/api/v1/channels/conexoes"))).text();
    const { data } = JSON.parse(texto) as { data: Array<Record<string, unknown>> };

    for (const cartao of data) {
      const chaves = [...Object.keys(cartao), ...Object.keys((cartao.oficial as object | null) ?? {})];
      for (const proibido of CAMPOS_PROIBIDOS) expect(chaves).not.toContain(proibido);
    }
    for (const valor of ["cifra-antiga", "segredo-cifrado", "ptk-a1", "ptk-a3", "token-da-instancia", "token-do-instagram", "token-do-parceiro"]) {
      expect(texto).not.toContain(valor);
    }
    // A consulta nem pede as colunas de segredo.
    for (const sel of db.selects) expect(sel).not.toMatch(/token|secret|metadata/);
  });

  it("sem autorização, a resposta da porta volta como está", async () => {
    makeDb([]);
    vi.mocked(autorizarAdministracao).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");
    expect((await GET(new NextRequest("https://crm.exemplo.com/api/v1/channels/conexoes"))).status).toBe(403);
  });
});
