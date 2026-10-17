import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn(), build: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3013" } }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.send }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Local", cor: "#000000" }) }));
vi.mock("@/lib/email/templates/invite", () => ({ buildInviteEmail: h.build }));
import { issueInvite } from "./issue-invite";
import { provaDoEmailConfere, verifyInviteToken } from "./invite-token";
const input = { email: "guest@example.test", role: "admin" as const,
  organizationId: "a2180000-0000-4000-8000-000000000001", orgName: "Org",
  inviterId: "a2180000-0000-4000-8000-000000000002", inviterName: "Admin", requestId: "test" };
beforeEach(() => {
  vi.resetAllMocks();
  h.build.mockReturnValue({ subject: "Convite", html: "Convite", text: "Convite" });
});
it("sem serviço de e-mail continua com link assinado, validade e auditoria sem token", async () => {
  h.send.mockResolvedValue({ ok: false, error: "not_configured" });
  const result = await issueInvite(input);
  const token = result.accept_url.split("/").at(-1)!;
  expect(result.email_dispatched).toBe(false);
  expect(result.email_error).toBe("not_configured");
  expect(verifyInviteToken(token)).toMatchObject({ invited_by: input.inviterId, organization_id: input.organizationId, role: "admin" });
  expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now());
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain(token);
});
it("falha lançada pelo envio continua com recuperação visível", async () => {
  h.send.mockRejectedValue(new Error("network failure"));
  const result = await issueInvite(input);
  expect(result.email_dispatched).toBe(false);
  expect(result.email_error).toBe("send_failed");
  expect(result.accept_url).toContain("/team/accept-invite/");
});
it("replay usa identidade/prazo estáveis e não reenvia", async () => {
  const args = { ...input, dispatch: false, inviteId: input.inviterId, issuedAt: Math.floor(Date.now()/1000) };
  expect(await issueInvite(args)).toEqual(await issueInvite(args));
  expect(h.send).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
});
it("D-204: o link do E-MAIL leva a prova `v` do convite; o accept_url devolvido (tela e API) NÃO", async () => {
  h.send.mockResolvedValue({ ok: true, via: "smtp" });
  const result = await issueInvite(input);
  const doEmail = new URL(h.build.mock.calls[0]![0].acceptUrl as string);
  const v = doEmail.searchParams.get("v");
  const token = doEmail.pathname.split("/").at(-1)!;
  expect(v).toBeTruthy();
  expect(provaDoEmailConfere(verifyInviteToken(token)!, v)).toBe(true);
  expect(result.accept_url).not.toContain("v=");
  expect(result.accept_url).not.toContain("?");
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain(v!);
  expect(JSON.stringify(result)).not.toContain(v!);
});
it("D-204: reenviar gera link novo com `v` válido para o token vigente", async () => {
  h.send.mockResolvedValue({ ok: true, via: "smtp" });
  const iat = Math.floor(Date.now() / 1000);
  const args = { ...input, inviteId: input.inviterId };
  await issueInvite({ ...args, issuedAt: iat - 120 });
  await issueInvite({ ...args, issuedAt: iat });
  const [antigo, novo] = h.build.mock.calls.map((c) => new URL(c[0].acceptUrl as string));
  const payloadNovo = verifyInviteToken(novo!.pathname.split("/").at(-1)!)!;
  expect(provaDoEmailConfere(payloadNovo, novo!.searchParams.get("v"))).toBe(true);
  expect(provaDoEmailConfere(payloadNovo, antigo!.searchParams.get("v"))).toBe(false);
});
