import { describe, it, expect } from "vitest";
import {
  signInviteToken,
  verifyInviteToken,
  provaDoEmailDoConvite,
  provaDoEmailConfere,
  INVITE_TTL_SECONDS,
} from "./invite-token";

const base = () => ({
  invite_id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  organization_id: "22222222-2222-4222-8222-222222222222",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
});

describe("invite-token", () => {
  it("sign+verify roundtrip recovers payload", () => {
    const payload = base();
    const token = signInviteToken(payload);
    const out = verifyInviteToken(token);
    expect(out).toEqual(payload);
  });

  it("returns null for expired token", () => {
    const expired = { ...base(), exp: Math.floor(Date.now() / 1000) - 10 };
    const token = signInviteToken(expired);
    expect(verifyInviteToken(token)).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${body}.${flipped}`)).toBeNull();
  });

  it("returns null for tampered body", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${flipped}.${sig}`)).toBeNull();
  });

  it("returns null for malformed token (no dot)", () => {
    expect(verifyInviteToken("notatoken")).toBeNull();
  });
});

  it("rejects signed machine/unknown roles and malformed identities", () => {
    for (const role of ["ai_operator", "superadmin", ""]) {
      expect(verifyInviteToken(signInviteToken({ ...base(), role }))).toBeNull();
    }
    expect(verifyInviteToken(signInviteToken({ ...base(), organization_id: "not-uuid" }))).toBeNull();
  });
  it("preserves signed inviter and issuance time", () => {
    const p = { ...base(), invited_by: "33333333-3333-4333-8333-333333333333", iat: Math.floor(Date.now()/1000) };
    expect(verifyInviteToken(signInviteToken(p))).toEqual(p);
  });

describe("prova de posse do e-mail do convite (`v`, D-204)", () => {
  const payload = () => ({ ...base(), iat: Math.floor(Date.now() / 1000) });

  it("confere para o próprio convite e é estável (o link do e-mail é recalculável)", () => {
    const p = payload();
    const v = provaDoEmailDoConvite(p);
    expect(provaDoEmailConfere(p, v)).toBe(true);
    expect(provaDoEmailDoConvite(p)).toBe(v);
  });

  it("não é a assinatura do token nem aparece no token (domínio próprio)", () => {
    const p = payload();
    const token = signInviteToken(p);
    expect(token.split(".")[1]).not.toBe(provaDoEmailDoConvite(p));
    expect(token).not.toContain(provaDoEmailDoConvite(p));
  });

  it("muda com o convite, o e-mail, o papel e o reenvio (outro iat/exp)", () => {
    const p = payload();
    const v = provaDoEmailDoConvite(p);
    for (const outro of [
      { ...p, invite_id: "99999999-9999-4999-8999-999999999999" },
      { ...p, email: "bob@example.com" },
      { ...p, role: "admin" },
      { ...p, iat: p.iat + 60, exp: p.exp + 60 },
    ]) {
      expect(provaDoEmailConfere(outro, v)).toBe(false);
    }
  });

  it("recusa ausente, vazio, truncado, com sobra ou adulterado", () => {
    const p = payload();
    const v = provaDoEmailDoConvite(p);
    const trocado = v.slice(0, -1) + (v.endsWith("A") ? "B" : "A");
    for (const ruim of [undefined, null, "", v.slice(0, -1), `${v}x`, trocado]) {
      expect(provaDoEmailConfere(p, ruim)).toBe(false);
    }
  });
});
