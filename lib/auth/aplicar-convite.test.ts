/**
 * CONVITE REVOGADO NÃO VIRA VÍNCULO — a porta onde a LINHA é consultada.
 *
 * ## Por que esta cerca existe
 *
 * Revogar um convite é um ato de segurança: alguém que ia entrar não vai mais.
 * O token, porém, continua na caixa de e-mail da pessoa, e ele é um HMAC com
 * validade — `verifyInviteToken` confere ASSINATURA e `exp`, e mais nada
 * (`lib/auth/invite-token.ts`). Nenhuma verificação de token sabe que o convite
 * morreu: quem sabe é a linha em `team_invites`.
 *
 * Esta casa já pagou uma vez por isso. O cabeçalho do módulo conta: a checagem
 * nasceu no BOTÃO de aceite (PR #664), e quem chegasse pelo OUTRO caminho —
 * confirmar o e-mail — passava por cima dela. Era o caminho de quem ainda não
 * tem conta, ou seja, o caso comum.
 *
 * Medido em 2026-09-14: o módulo não tinha arquivo de teste nenhum. É a peça de
 * que a segurança de `/auth/confirm` inteiramente depende — a cerca de lá
 * (`tests/unit/convite-revogado-nao-da-acesso.test.ts`) precisa mockar este
 * módulo para medir o degradê, então só este arquivo prova que a recusa existe.
 *
 * ## Comando
 *
 *     npx vitest run lib/auth/aplicar-convite.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { provaDoEmailDoConvite } from "@/lib/auth/invite-token";
import type { gotrueFalso as gotrueFalsoTipo } from "../../tests/unit/helpers/gotrue-admin-falso";

const ORG = "33333333-3333-4333-8333-333333333333";
const CONVITE = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "11111111-1111-4111-8111-111111111111";

const PAYLOAD = {
  invite_id: CONVITE,
  email: "revogada@example.com",
  organization_id: ORG,
  role: "manager" as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn() })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));

/** A RPC que efetiva o vínculo — o ato que um revogado não pode alcançar. */
const rpcDoAceite = vi.fn(async () => ({ data: { id: "m1", changed: true }, error: null }));

/**
 * Dublê do admin client. `select` devolve a linha de `team_invites` pedida;
 * `update` (o fechamento do convite) aceita e não diz nada.
 */
function adminComConvite(linha: { revoked_at: string | null; role: string } | null) {
  const cadeiaDeUpdate = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "is"]) c[m] = () => c;
    c.then = (r: (v: unknown) => unknown) => r({ data: null, error: null });
    return c;
  };
  return {
    from: () => ({
      select: () => {
        const c: Record<string, unknown> = {};
        for (const m of ["eq", "is"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: linha, error: null });
        return c;
      },
      update: cadeiaDeUpdate,
    }),
    rpc: rpcDoAceite,
    // A conta que aceita: por padrão VERIFICADA (sem pedido em aberto), como toda conta de antes do D-204.
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: { user: { id: USUARIO_ID, app_metadata: appMetadataDaConta } },
          error: null,
        })),
      },
    },
  };
}

let appMetadataDaConta: Record<string, unknown> = {};

async function aplicar(
  linha: { revoked_at: string | null; role: string } | null,
  payload: typeof PAYLOAD & { invited_by?: string } = PAYLOAD,
) {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue(adminComConvite(linha) as never);
  const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
  return aplicarConvite({ userId: USUARIO_ID, payload });
}

describe("aplicarConvite consulta a LINHA, não só o token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMetadataDaConta = {};
  });

  it("⭐ convite REVOGADO é recusado, e o vínculo nunca chega a ser tentado", async () => {
    const r = await aplicar({ revoked_at: "2026-09-13T10:00:00Z", role: "manager" });

    expect(
      r,
      "um convite revogado virou vínculo: quem foi desconvidado entra na organização assim mesmo, com o papel que o token carrega",
    ).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(
      rpcDoAceite,
      "`fn_accept_team_invite` foi chamada para um convite revogado — a recusa passou a depender inteiramente da função do banco, e a checagem deste módulo não está fazendo nada",
    ).not.toHaveBeenCalled();
  });

  it("convite VIVO passa — o par de vacuidade, senão o caso acima não prova nada", async () => {
    const r = await aplicar({ revoked_at: null, role: "manager" });

    expect(
      r.ok,
      "nem o convite vivo passa: a sonda recusa tudo, e o caso da revogação está verde pelo motivo errado",
    ).toBe(true);
    expect(rpcDoAceite).toHaveBeenCalled();
  });

  it("convite SEM linha mas COM convidador segue o fluxo: o dono de um tenant novo nasce assim", async () => {
    // Ausência de linha NÃO é revogação. `/api/v1/admin/tenants` emite o convite
    // do dono sem gravar `team_invites` (a idempotência é do `invite_id` da
    // criação), mas o token sempre traz `invited_by`. Endurecer a guarda para
    // `!linha || linha.revoked_at` quebraria a criação de organizações.
    expect((await aplicar(null, { ...PAYLOAD, invited_by: USUARIO_ID })).ok).toBe(true);
  });

  it("⭐ convite SEM linha e SEM convidador é recusado: o formato da action do onboarding sem portão (D-089)", async () => {
    // Um viewer emitia token com papel admin pela action do onboarding, que não
    // gravava linha nem `invited_by`. Nenhum emissor atual produz esse formato;
    // o token que sobrou na rua (validade de 24h) não vira vínculo.
    const r = await aplicar(null);
    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("D-204: conta com a verificação do CRM EM ABERTO não ganha vínculo por convite (o link não prova o e-mail)", async () => {
    appMetadataDaConta = { email_verificacao: { hash: "h", expira_em: "2099-01-01T00:00:00Z", enviado_em: "2026-10-17T00:00:00Z" } };
    const r = await aplicar({ revoked_at: null, role: "manager" });

    expect(r).toEqual({ ok: false, motivo: "email_nao_verificado" });
    expect(rpcDoAceite, "o vínculo foi gravado para uma conta sem o e-mail provado").not.toHaveBeenCalled();
  });

  it("D-204: conta JÁ verificada aceita sem `v` e não reescreve nada na conta", async () => {
    appMetadataDaConta = {};
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { gotrueFalso } = await import("../../tests/unit/helpers/gotrue-admin-falso");
    const falso = gotrueFalso({ appMetadata: {} });
    const admin = { ...adminComConvite({ revoked_at: null, role: "manager" }), auth: falso.admin.auth };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    const r = await aplicarConvite({ userId: USUARIO_ID, payload: PAYLOAD });

    expect(r.ok).toBe(true);
    expect(falso.chamadas).toEqual([]);
    expect(falso.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it("D-204: não conseguiu ler a conta: FALHA FECHADA, sem vínculo", async () => {
    appMetadataDaConta = {};
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = adminComConvite({ revoked_at: null, role: "manager" });
    admin.auth.admin.getUserById = vi.fn(async () => ({ data: { user: null }, error: { message: "x" } })) as never;
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    const r = await aplicarConvite({ userId: USUARIO_ID, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("a recusa da própria função do banco (42501) também não é vínculo", async () => {
    // Segunda linha de defesa: mesmo que a linha diga que o convite vive, a
    // `fn_accept_team_invite` recusa quem foi revogado DEPOIS da emissão. O
    // código 42501 é recusa de política, e não pode virar 500.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = adminComConvite({ revoked_at: null, role: "manager" });
    admin.rpc = vi.fn(async () => ({ data: null, error: { code: "42501" } })) as never;
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    expect(await aplicarConvite({ userId: USUARIO_ID, payload: PAYLOAD })).toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
  });
});

describe("D-100: reenviar o convite com outro papel mata o link do papel antigo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("link assinado como admin com a linha já em viewer é recusado, e o vínculo nunca é tentado", async () => {
    const r = await aplicar(
      { revoked_at: null, role: "viewer" },
      { ...PAYLOAD, role: "admin" as never },
    );
    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("o link do papel atual da linha segue valendo (par de vacuidade)", async () => {
    const r = await aplicar({ revoked_at: null, role: "viewer" }, { ...PAYLOAD, role: "viewer" as never });
    expect(r.ok).toBe(true);
    expect(rpcDoAceite).toHaveBeenCalledTimes(1);
  });
});


describe("D-204: o link que chega POR E-MAIL prova a posse (`v`); o accept_url do admin não", () => {
  const EMAIL = "v@example.com"; // o e-mail que o `gotrueFalso` dá à conta
  const PAYLOAD_EMAIL = { ...PAYLOAD, email: EMAIL, iat: Math.floor(Date.now() / 1000) };

  beforeEach(() => vi.clearAllMocks());

  async function aplicarComPedidoAberto(
    prova: string | null | undefined,
    payload: Parameters<typeof provaDoEmailDoConvite>[0] = PAYLOAD_EMAIL,
    opcoes: Parameters<typeof gotrueFalsoTipo>[0] = {},
  ) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { gotrueFalso } = await import("../../tests/unit/helpers/gotrue-admin-falso");
    const falso = gotrueFalso(opcoes); // padrão: pedido de verificação em aberto
    const admin = { ...adminComConvite({ revoked_at: null, role: "manager" }), auth: falso.admin.auth };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    const r = await aplicarConvite({ userId: USUARIO_ID, payload, provaDoEmail: prova });
    return { r, falso };
  }

  it("⭐ com `v` válido e o e-mail do convite: carimba o e-mail como verificado e aplica o convite", async () => {
    const { r, falso } = await aplicarComPedidoAberto(provaDoEmailDoConvite(PAYLOAD_EMAIL));

    expect(r.ok, "o convidado que clicou no link do próprio e-mail ainda precisaria de um segundo e-mail").toBe(true);
    expect(rpcDoAceite).toHaveBeenCalledTimes(1);
    expect(falso.chamadas).toEqual(["carimbo"]);
    expect(falso.estado.app_metadata.email_verificado_em).toEqual(expect.any(String));
    expect(falso.estado.app_metadata.email_verificacao).toBeUndefined();
  });

  it("⭐ o link do admin (sem `v`) com pedido aberto segue recusado, sem carimbo e sem vínculo", async () => {
    for (const prova of [undefined, null, ""]) {
      const { r, falso } = await aplicarComPedidoAberto(prova);
      expect(r).toEqual({ ok: false, motivo: "email_nao_verificado" });
      expect(falso.chamadas).toEqual([]);
    }
    expect(rpcDoAceite, "o vínculo foi gravado para quem só tinha o link da tela do admin").not.toHaveBeenCalled();
  });

  it("`v` de OUTRO convite é recusado", async () => {
    const outro = { ...PAYLOAD_EMAIL, invite_id: "44444444-4444-4444-8444-444444444444" };
    const { r, falso } = await aplicarComPedidoAberto(provaDoEmailDoConvite(outro));
    expect(r).toEqual({ ok: false, motivo: "email_nao_verificado" });
    expect(falso.chamadas).toEqual([]);
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("`v` ADULTERADO (um caractere trocado, ou truncado) é recusado", async () => {
    const boa = provaDoEmailDoConvite(PAYLOAD_EMAIL);
    const trocada = `${boa.slice(0, -1)}${boa.endsWith("A") ? "B" : "A"}`;
    for (const prova of [trocada, boa.slice(0, -2), `${boa}x`]) {
      const { r } = await aplicarComPedidoAberto(prova);
      expect(r).toEqual({ ok: false, motivo: "email_nao_verificado" });
    }
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("`v` válido, mas a conta tem OUTRO e-mail que o do convite: recusado", async () => {
    const dePessoaDiferente = { ...PAYLOAD_EMAIL, email: "outra@example.com" };
    const { r, falso } = await aplicarComPedidoAberto(provaDoEmailDoConvite(dePessoaDiferente), dePessoaDiferente);
    expect(r).toEqual({ ok: false, motivo: "email_nao_verificado" });
    expect(falso.chamadas).toEqual([]);
  });

  it("falha ao gravar o carimbo: FALHA FECHADA, sem vínculo", async () => {
    const { r } = await aplicarComPedidoAberto(provaDoEmailDoConvite(PAYLOAD_EMAIL), PAYLOAD_EMAIL, {
      falharEm: "gravacao",
    });
    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(rpcDoAceite).not.toHaveBeenCalled();
  });

  it("conta já verificada: `v` é irrelevante e nada é reescrito", async () => {
    const { r, falso } = await aplicarComPedidoAberto(undefined, PAYLOAD_EMAIL, { appMetadata: {} });
    expect(r.ok).toBe(true);
    expect(falso.chamadas).toEqual([]);
  });
});
