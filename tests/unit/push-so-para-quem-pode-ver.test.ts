/**
 * D-097: o push só vai para quem ainda é membro da organização e pode ver a
 * conversa, e só chama endereços de serviço de push de navegador.
 *
 * `web-push` (biblioteca externa, a rede) é falso; `enviarPushDaOrg` e as regras de
 * visibilidade rodam de verdade, sobre um banco falso que responde às consultas de
 * inscrição e de vínculo. O que se mede é para QUEM o `sendNotification` foi chamado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const enviados: string[] = [];

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }) => {
      enviados.push(sub.endpoint);
    },
  },
}));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv", VAPID_PUBLIC_KEY: "pub", NEXT_PUBLIC_APP_URL: "https://x.test" } }));
vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@y.test",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { enviarPushAQuemVeAConversa, enviarPushDaOrg } from "@/lib/notifications/web_push";
import { endpointDePushPermitido } from "@/lib/notifications/endpoint-de-push";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const FCM = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;

interface Sub { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }
interface Vinculo { user_id: string; role: string; revoked_at: string | null }

/**
 * Banco falso: `push_subscriptions` (com o filtro por usuário que o aviso pessoal aplica),
 * `user_organizations` (só os vínculos NÃO revogados, como o `.is("revoked_at", null)` real),
 * `organizations` (sem linha: a tela bloqueada fica no padrão) e a RPC de quem vê a conversa.
 */
function banco(
  subs: Sub[],
  vinculos: Vinculo[] | "erro",
  opts: { quemVe?: Sub[] | "erro" } = {},
) {
  return {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        is: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        then: (r: (v: unknown) => unknown) => {
          if (tabela === "push_subscriptions") {
            const doUsuario = filtros.find(([c]) => c === "user_id")?.[1];
            return r({ data: subs.filter((x) => !doUsuario || x.user_id === doUsuario), error: null });
          }
          if (tabela === "user_organizations") {
            return r(
              vinculos === "erro"
                ? { data: null, error: { message: "falhou" } }
                : { data: vinculos.filter((v) => v.revoked_at === null), error: null },
            );
          }
          return r({ data: [], error: null });
        },
      };
      return q;
    },
    rpc: async (nome: string) => {
      if (nome !== "fn_push_inscricoes_que_veem_a_conversa") throw new Error(`rpc inesperada: ${nome}`);
      const quemVe = opts.quemVe ?? subs;
      return quemVe === "erro" ? { data: null, error: { message: "falhou" } } : { data: quemVe, error: null };
    },
  };
}

const sub = (user: string, endpoint = FCM(user)): Sub => ({ id: `s-${user}`, user_id: user, endpoint, p256dh: "k", auth: "a" });
const payload = { title: "t", body: "b", tag: "x", href: "/app/inbox" };

beforeEach(() => {
  enviados.length = 0;
});

describe("enviarPushDaOrg: quem ainda pertence à organização", () => {
  it("CONTROLE POSITIVO: membro ativo recebe", async () => {
    const r = await enviarPushDaOrg(ORG, payload, {}, banco([sub("ativo")], [{ user_id: "ativo", role: "agent", revoked_at: null }]) as never);
    expect(r.sent).toBe(1);
    expect(enviados).toEqual([FCM("ativo")]);
  });

  it("⭐ quem foi revogado da organização não recebe mais, e quem nunca foi membro também não", async () => {
    const r = await enviarPushDaOrg(
      ORG,
      payload,
      {},
      banco(
        [sub("revogado"), sub("estranho"), sub("ativo")],
        [
          { user_id: "revogado", role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
          { user_id: "ativo", role: "admin", revoked_at: null },
        ],
      ) as never,
    );
    expect(r.sent).toBe(1);
    expect(enviados).toEqual([FCM("ativo")]);
  });

  it("aviso pessoal: só o usuário pedido, e revogado não recebe nem o aviso pessoal", async () => {
    const vinculos: Vinculo[] = [
      { user_id: "a", role: "agent", revoked_at: null },
      { user_id: "b", role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
    ];
    await enviarPushDaOrg(ORG, payload, { soUsuario: "a" }, banco([sub("a"), sub("b")], vinculos) as never);
    expect(enviados).toEqual([FCM("a")]);
    enviados.length = 0;
    await enviarPushDaOrg(ORG, payload, { soUsuario: "b" }, banco([sub("a"), sub("b")], vinculos) as never);
    expect(enviados).toEqual([]);
  });

  it("falha ao consultar os vínculos: não manda para ninguém (falha fechada)", async () => {
    const r = await enviarPushDaOrg(ORG, payload, {}, banco([sub("a")], "erro") as never);
    expect(r.sent).toBe(0);
    expect(enviados).toEqual([]);
  });
});

/**
 * Quem PODE VER a conversa, desde o upstream, é decidido no banco: a RPC
 * `fn_push_inscricoes_que_veem_a_conversa` aplica `fn_can_view_conversation` (a RLS
 * de `conversations`), e os modos `own` / `own_and_unassigned` / `all` são provados em
 * `tests/invariants/push-so-a-quem-ve-a-conversa.test.ts`. Aqui se mede o que o envio
 * faz com o que a RPC devolve.
 */
describe("enviarPushAQuemVeAConversa: só quem pode ver a conversa", () => {
  const vinculos: Vinculo[] = [
    { user_id: "dono", role: "agent", revoked_at: null },
    { user_id: "outro-agent", role: "agent", revoked_at: null },
    { user_id: "gerente", role: "manager", revoked_at: null },
  ];
  const todos = () => ["dono", "outro-agent", "gerente"].map((u) => sub(u));

  it("⭐ só recebe quem a RPC diz que vê: o outro atendente fica de fora", async () => {
    const quemVe = [sub("dono"), sub("gerente")];
    await enviarPushAQuemVeAConversa(ORG, CONVERSA, payload, undefined, banco(todos(), vinculos, { quemVe }) as never);
    expect(enviados.sort()).toEqual([FCM("dono"), FCM("gerente")].sort());
  });

  it("a RPC não alarga a membresia: quem vê mas foi revogado não recebe", async () => {
    const revogado: Vinculo[] = [...vinculos.filter((v) => v.user_id !== "dono"), { user_id: "dono", role: "agent", revoked_at: "2026-09-01T00:00:00Z" }];
    await enviarPushAQuemVeAConversa(ORG, CONVERSA, payload, undefined, banco(todos(), revogado, { quemVe: [sub("dono"), sub("gerente")] }) as never);
    expect(enviados).toEqual([FCM("gerente")]);
  });

  it("a lista de quem deve ser avisado só estreita, nunca alarga além de quem vê", async () => {
    await enviarPushAQuemVeAConversa(ORG, CONVERSA, payload, ["dono", "outro-agent"], banco(todos(), vinculos, { quemVe: [sub("dono"), sub("gerente")] }) as never);
    expect(enviados).toEqual([FCM("dono")]);
    enviados.length = 0;
    const r = await enviarPushAQuemVeAConversa(ORG, CONVERSA, payload, [], banco(todos(), vinculos) as never);
    expect(r.sent).toBe(0);
    expect(enviados).toEqual([]);
  });

  it("falha ao perguntar quem vê: não manda para ninguém (falha fechada)", async () => {
    const r = await enviarPushAQuemVeAConversa(ORG, CONVERSA, payload, undefined, banco(todos(), vinculos, { quemVe: "erro" }) as never);
    expect(r.sent).toBe(0);
    expect(enviados).toEqual([]);
  });
});

describe("D-097 vizinho: o servidor só chama serviços de push de navegador", () => {
  it("⭐ endereço interno ou http na inscrição não é chamado no envio", async () => {
    const vinculos: Vinculo[] = ["a", "b", "c", "d"].map((u) => ({ user_id: u, role: "admin", revoked_at: null }));
    await enviarPushDaOrg(
      ORG,
      payload,
      {},
      banco(
        [
          sub("a", "http://169.254.169.254/latest/meta-data"),
          sub("b", "https://servico-interno.local/hook"),
          sub("c", "https://fcm.googleapis.com.atacante.test/x"),
          sub("d", FCM("d")),
        ],
        vinculos,
      ) as never,
    );
    expect(enviados).toEqual([FCM("d")]);
  });

  it("endpointDePushPermitido", () => {
    expect(endpointDePushPermitido(FCM("x"))).toBe(true);
    expect(endpointDePushPermitido("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(endpointDePushPermitido("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(endpointDePushPermitido("https://web.push.apple.com/abc")).toBe(true);
    expect(endpointDePushPermitido("http://fcm.googleapis.com/x")).toBe(false);
    expect(endpointDePushPermitido("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(endpointDePushPermitido("https://u:p@fcm.googleapis.com/x")).toBe(false);
    expect(endpointDePushPermitido("https://localhost/x")).toBe(false);
    expect(endpointDePushPermitido("não é url")).toBe(false);
  });
});

describe("PUT /api/v1/notifications/push recusa endpoint fora dos serviços de push", () => {
  it("422 para endereço interno; 200 para o do Chrome", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth/require-role", () => ({
      requireRole: async () => ({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG, role: "viewer" } }),
    }));
    vi.doMock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({ from: () => ({ upsert: async () => ({ error: null }) }) }),
    }));
    const { PUT } = await import("@/app/api/v1/notifications/push/route");
    const corpo = (endpoint: string) =>
      new NextRequest("http://localhost/api/v1/notifications/push", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } }),
      });
    expect((await PUT(corpo("https://servico-interno.local/hook"))).status).toBe(422);
    expect((await PUT(corpo("http://169.254.169.254/x"))).status).toBe(422);
    expect((await PUT(corpo(FCM("novo")))).status).toBe(200);
  });
});
