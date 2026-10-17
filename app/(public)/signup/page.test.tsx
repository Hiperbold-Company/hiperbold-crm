/**
 * D-204: o `v` do link do e-mail do convite atravessa o cadastro (`/signup?invite=&v=`) até o aceite, mas só quando
 * confere com ESTE convite. `v` inválido ou de outro convite é descartado aqui, sem aviso.
 */
import { describe, expect, it, vi } from "vitest";

import { provaDoEmailDoConvite, signInviteToken, type InvitePayload } from "@/lib/auth/invite-token";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/branding", () => ({ branding: () => ({ name: "CRM" }) }));
vi.mock("@/lib/security/turnstile", () => ({ turnstileSiteKey: () => null }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: async () => "aberto" }));
vi.mock("@/lib/onboarding/precisa-pagar", () => ({ compraPeloClienteDisponivel: async () => false }));
vi.mock("@/components/auth/SignupForm", () => ({ SignupForm: () => null }));
vi.mock("@/components/auth/EntrarComGoogle", () => ({ EntrarComGoogle: () => null }));

import SignupPage from "./page";

const payload: InvitePayload = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidada@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "agent",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  invited_by: "44444444-4444-4444-8444-444444444444",
};
const token = signInviteToken(payload);

/** Acha as props do `<SignupForm>` na árvore devolvida pela página. */
function propsDoForm(no: unknown): { convite?: { token: string; email: string; prova?: string } } | null {
  if (!no || typeof no !== "object") return null;
  const el = no as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === "function" && el.props && "turnstileSiteKey" in el.props) return el.props as never;
  const filhos = el.props?.children;
  for (const f of Array.isArray(filhos) ? filhos : [filhos]) {
    const achou = propsDoForm(f);
    if (achou) return achou;
  }
  return null;
}

async function abrir(v?: string) {
  const el = await SignupPage({ searchParams: Promise.resolve({ invite: token, ...(v === undefined ? {} : { v }) }) });
  return propsDoForm(el);
}

describe("página de cadastro por convite (D-204)", () => {
  it("v válido para este convite chega ao formulário como `convite.prova`", async () => {
    const v = provaDoEmailDoConvite(payload);
    expect((await abrir(v))?.convite).toEqual({ token, email: payload.email, prova: v });
  });

  it("sem v, v de outro convite ou adulterado: o formulário não recebe prova", async () => {
    const outro = provaDoEmailDoConvite({ ...payload, invite_id: "55555555-5555-4555-8555-555555555555" });
    for (const v of [undefined, outro, "lixo"]) {
      const convite = (await abrir(v))?.convite;
      expect(convite?.token).toBe(token);
      expect(convite?.prova).toBeUndefined();
    }
  });
});
