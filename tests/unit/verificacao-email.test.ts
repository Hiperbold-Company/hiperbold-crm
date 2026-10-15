/**
 * A verificação de e-mail do CRM (`lib/auth/verificacao-email.ts`): token de uso único, 7 dias, guardado só
 * como hash, e a regra de quem conta como verificado (as contas que já existiam NÃO veem a faixa).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  consumirToken,
  emailVerificado,
  emitirPedido,
  gerarToken,
  hashDoSegredo,
  lerToken,
  pedidoEmAberto,
  VALIDADE_DO_LINK_EM_DIAS,
} from "@/lib/auth/verificacao-email";

import { criarAuthAdminFalso } from "./helpers/auth-admin-falso";

const USER = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-10-15T12:00:00Z");
const dias = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

describe("token: geração, forma e hash", () => {
  it("o link leva <user_id>.<segredo>, e o que se guarda é o SHA-256 do segredo, nunca o segredo", () => {
    const { token, hash } = gerarToken(USER);
    const lido = lerToken(token);
    expect(lido?.userId).toBe(USER);
    expect(hash).toBe(createHash("sha256").update(lido!.segredo).digest("hex"));
    expect(hash).toBe(hashDoSegredo(lido!.segredo));
    expect(hash).not.toContain(lido!.segredo);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dois tokens da mesma conta nunca coincidem", () => {
    expect(gerarToken(USER).token).not.toBe(gerarToken(USER).token);
  });

  it.each([
    ["vazio", ""],
    ["sem ponto", USER],
    ["id que não é uuid", "abc.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["segredo curto", `${USER}.curto`],
    ["segredo com caractere fora do base64url", `${USER}.${"+".repeat(43)}`],
    ["não é texto", 42],
    ["nulo", null],
  ])("forma errada é recusada antes de qualquer consulta: %s", (_nome, valor) => {
    expect(lerToken(valor)).toBeNull();
  });
});

describe("quem conta como verificado", () => {
  it("conta que já existia (sem pedido em aberto) é verificada: não vê a faixa", () => {
    expect(emailVerificado({})).toBe(true);
    expect(emailVerificado({ provider: "email", providers: ["email"] })).toBe(true);
    expect(emailVerificado(undefined)).toBe(true);
    expect(emailVerificado(null)).toBe(true);
  });

  it("entrou com o Google (sem pedido): verificada", () => {
    expect(emailVerificado({ provider: "google", providers: ["google"] })).toBe(true);
  });

  it("cadastro novo com pedido em aberto NÃO é verificado", () => {
    const { hash } = gerarToken(USER);
    const pedido = { hash, expira_em: dias(7).toISOString(), enviado_em: T0.toISOString() };
    expect(emailVerificado({ email_verificacao: pedido })).toBe(false);
  });

  it("com o carimbo email_verificado_em é verificado, mesmo que sobre um pedido", () => {
    const { hash } = gerarToken(USER);
    const pedido = { hash, expira_em: dias(7).toISOString(), enviado_em: T0.toISOString() };
    expect(emailVerificado({ email_verificado_em: T0.toISOString(), email_verificacao: pedido })).toBe(true);
  });

  it("pedido mal formado não vira 'pendente' (falha aberta, e a faixa nunca bloqueia)", () => {
    expect(pedidoEmAberto({ email_verificacao: { hash: 1 } })).toBeNull();
    expect(emailVerificado({ email_verificacao: "x" })).toBe(true);
  });
});

describe("emitir e consumir o token", () => {
  function conta() {
    return criarAuthAdminFalso([
      { id: USER, email: "dono@exemplo.test", app_metadata: { provider: "email", providers: ["email"] } },
      { id: OUTRO, email: "outra@exemplo.test", app_metadata: { provider: "email", providers: ["email"] } },
    ]);
  }

  it("grava só o hash, com validade de 7 dias, e preserva o resto do app_metadata", async () => {
    const f = conta();
    const r = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0, junto: { aceite_termos: { versao: "v" } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const meta = f.appMetadata(USER);
    const pedido = pedidoEmAberto(meta)!;
    expect(VALIDADE_DO_LINK_EM_DIAS).toBe(7);
    expect(pedido.expira_em).toBe(dias(7).toISOString());
    expect(pedido.enviado_em).toBe(T0.toISOString());
    expect(pedido.hash).toBe(hashDoSegredo(lerToken(r.token)!.segredo));
    // O segredo não está em lugar nenhum do que foi gravado.
    expect(JSON.stringify(meta)).not.toContain(lerToken(r.token)!.segredo);
    expect(meta.provider).toBe("email");
    expect(meta.aceite_termos).toEqual({ versao: "v" });
    expect(emailVerificado(meta)).toBe(false);
  });

  it("abrir o link carimba a conta e apaga o pedido", async () => {
    const f = conta();
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!e.ok) throw new Error("emissão falhou");

    const r = await consumirToken({ admin: f.cliente, token: e.token, agora: dias(1) });
    expect(r).toEqual({ ok: true, userId: USER, email: "dono@exemplo.test" });

    const meta = f.appMetadata(USER);
    expect(meta.email_verificado_em).toBe(dias(1).toISOString());
    expect(meta.email_verificacao).toBeUndefined();
    expect(emailVerificado(meta)).toBe(true);
    // Não mexeu em quem não tem nada a ver com isto.
    expect(emailVerificado(f.appMetadata(OUTRO))).toBe(true);
    expect(f.appMetadata(OUTRO).email_verificado_em).toBeUndefined();
  });

  it("USO ÚNICO: o mesmo link, aberto de novo, não vale", async () => {
    const f = conta();
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!e.ok) throw new Error("emissão falhou");

    expect((await consumirToken({ admin: f.cliente, token: e.token, agora: dias(1) })).ok).toBe(true);
    const segunda = await consumirToken({ admin: f.cliente, token: e.token, agora: dias(2) });
    expect(segunda).toEqual({ ok: false, motivo: "token_invalido" });
    // E o carimbo da primeira vez não foi regravado.
    expect(f.appMetadata(USER).email_verificado_em).toBe(dias(1).toISOString());
  });

  it("⭐ o pedido consumido é removido com `null` EXPLÍCITO (o GoTrue mescla; chave omitida continuaria gravada e o link seria reutilizável)", async () => {
    const f = conta();
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!e.ok) throw new Error("emissão falhou");
    const antes = f.escritas.length;

    expect((await consumirToken({ admin: f.cliente, token: e.token, agora: dias(1) })).ok).toBe(true);
    // O falso mescla como o GoTrue: só o `null` remove. A prova de que o dado SAIU do provedor é a chave ausente.
    expect(Object.keys(f.appMetadata(USER))).not.toContain("email_verificacao");
    expect(f.escritas.length).toBe(antes + 1);

    // Reusar o mesmo link, mesmo muito depois, não volta a valer nem regrava nada.
    const reuso = await consumirToken({ admin: f.cliente, token: e.token, agora: dias(3) });
    expect(reuso).toEqual({ ok: false, motivo: "token_invalido" });
    expect(f.escritas.length).toBe(antes + 1);
  });

  it("vale até o instante de vencer: 6 dias e 23 horas passa; 7 dias exatos e depois, não", async () => {
    const f = conta();
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!e.ok) throw new Error("emissão falhou");

    const quaseVencido = new Date(dias(7).getTime() - 60 * 60 * 1000);
    expect((await consumirToken({ admin: f.cliente, token: e.token, agora: quaseVencido })).ok).toBe(true);

    const g = conta();
    const e2 = await emitirPedido({ admin: g.cliente, userId: USER, agora: T0 });
    if (!e2.ok) throw new Error("emissão falhou");
    expect(await consumirToken({ admin: g.cliente, token: e2.token, agora: dias(7) })).toEqual({
      ok: false,
      motivo: "expirado",
    });
    expect(await consumirToken({ admin: g.cliente, token: e2.token, agora: dias(30) })).toEqual({
      ok: false,
      motivo: "expirado",
    });
    // Vencido não carimba.
    expect(emailVerificado(g.appMetadata(USER))).toBe(false);
  });

  it("segredo errado, segredo de outra conta e token adulterado são recusados sem escrever nada", async () => {
    const f = conta();
    const dele = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    const dela = await emitirPedido({ admin: f.cliente, userId: OUTRO, agora: T0 });
    if (!dele.ok || !dela.ok) throw new Error("emissão falhou");
    const escritasAntes = f.escritas.length;

    const segredoDela = lerToken(dela.token)!.segredo;
    const trocado = `${USER}.${segredoDela}`; // id de uma conta, segredo de outra
    const adulterado = `${dele.token.slice(0, -1)}${dele.token.endsWith("A") ? "B" : "A"}`;
    const outroId = `33333333-3333-4333-8333-333333333333.${segredoDela}`; // conta que não existe

    for (const token of [trocado, adulterado, outroId, "lixo", undefined]) {
      expect((await consumirToken({ admin: f.cliente, token, agora: dias(1) })).ok).toBe(false);
    }
    expect(f.escritas.length).toBe(escritasAntes);
    expect(emailVerificado(f.appMetadata(USER))).toBe(false);
    expect(emailVerificado(f.appMetadata(OUTRO))).toBe(false);
  });

  it("pedir outro link troca o pedido: o anterior deixa de valer", async () => {
    const f = conta();
    const primeiro = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    const segundo = await emitirPedido({ admin: f.cliente, userId: USER, agora: dias(1) });
    if (!primeiro.ok || !segundo.ok) throw new Error("emissão falhou");

    expect(await consumirToken({ admin: f.cliente, token: primeiro.token, agora: dias(2) })).toEqual({
      ok: false,
      motivo: "token_invalido",
    });
    expect((await consumirToken({ admin: f.cliente, token: segundo.token, agora: dias(2) })).ok).toBe(true);
  });

  it("falha do provedor ao gravar: não finge que verificou", async () => {
    const f = conta();
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!e.ok) throw new Error("emissão falhou");
    f.falharGravacao(true);
    expect(await consumirToken({ admin: f.cliente, token: e.token, agora: dias(1) })).toEqual({
      ok: false,
      motivo: "gravacao_falhou",
    });
    expect(emailVerificado(f.appMetadata(USER))).toBe(false);
  });
});

describe("reabrir o pedido (o reenvio)", () => {
  it("conta que já existia (sem pedido) não ganha pedido por chamar o reenvio: continua sem faixa", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "a@b.test", app_metadata: { provider: "email" } }]);
    const r = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0, somenteSePendente: true });
    expect(r).toEqual({ ok: false, motivo: "ja_verificado" });
    expect(f.escritas).toHaveLength(0);
    expect(emailVerificado(f.appMetadata(USER))).toBe(true);
  });

  it("conta já carimbada: recusa", async () => {
    const f = criarAuthAdminFalso([
      { id: USER, email: "a@b.test", app_metadata: { email_verificado_em: T0.toISOString() } },
    ]);
    expect(await emitirPedido({ admin: f.cliente, userId: USER, agora: dias(1) })).toEqual({
      ok: false,
      motivo: "ja_verificado",
    });
    expect(f.escritas).toHaveLength(0);
  });

  it("menos de 1 minuto desde o último envio: recusa e mantém o pedido anterior; depois de 1 minuto, troca", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "a@b.test", app_metadata: {} }]);
    const primeiro = await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 });
    if (!primeiro.ok) throw new Error("emissão falhou");

    const cedo = await emitirPedido({
      admin: f.cliente,
      userId: USER,
      agora: new Date(T0.getTime() + 30_000),
      intervaloMinimoMs: 60_000,
      somenteSePendente: true,
    });
    expect(cedo).toEqual({ ok: false, motivo: "muito_cedo" });
    expect((await consumirToken({ admin: f.cliente, token: primeiro.token, agora: dias(1) })).ok).toBe(true);

    const g = criarAuthAdminFalso([{ id: USER, email: "a@b.test", app_metadata: {} }]);
    await emitirPedido({ admin: g.cliente, userId: USER, agora: T0 });
    const tarde = await emitirPedido({
      admin: g.cliente,
      userId: USER,
      agora: new Date(T0.getTime() + 61_000),
      intervaloMinimoMs: 60_000,
      somenteSePendente: true,
    });
    expect(tarde.ok).toBe(true);
  });

  it("usuário inexistente: motivo claro, sem lançar", async () => {
    const f = criarAuthAdminFalso([]);
    expect(await emitirPedido({ admin: f.cliente, userId: USER, agora: T0 })).toEqual({
      ok: false,
      motivo: "usuario_nao_encontrado",
    });
  });
});
