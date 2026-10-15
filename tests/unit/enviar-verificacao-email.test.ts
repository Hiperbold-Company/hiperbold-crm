/**
 * O envio do "Confirme seu e-mail" e os tetos do "Reenviar" (1 por minuto, 5 por dia por usuário).
 * Os limites vêm do limitador real em produção; aqui o limitador é um contador com a MESMA semântica
 * (incrementa e compara com o teto), para o teste provar o que o envio PEDE ao limitador e como reage.
 */
import { describe, expect, it, vi } from "vitest";

import { enviarVerificacaoDeEmail, LIMITES_DO_REENVIO, type DepsDoEnvioDaVerificacao } from "@/lib/auth/enviar-verificacao-email";
import { consumirToken, emailVerificado, lerToken, pedidoEmAberto } from "@/lib/auth/verificacao-email";

import { criarAuthAdminFalso } from "./helpers/auth-admin-falso";

const USER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-15T12:00:00Z");

const MARCA = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0f766e",
  accentFg: "#ffffff",
} as never;

function montar(opcoes: { appMetadata?: Record<string, unknown>; envio?: "ok" | "falha" | "sem_config" } = {}) {
  const f = criarAuthAdminFalso([
    { id: USER, email: "Dono@Exemplo.test", app_metadata: opcoes.appMetadata ?? { provider: "email", providers: ["email"] } },
  ]);
  const contadores = new Map<string, number>();
  const enviados: Array<{ to: unknown; subject: string; html: string; text?: string }> = [];
  const auditorias: Array<Record<string, unknown>> = [];
  let agora = T0;

  const deps: DepsDoEnvioDaVerificacao = {
    admin: f.cliente,
    enviar: vi.fn(async (a) => {
      if (opcoes.envio === "falha") return { ok: false, error: "send_failed" as const };
      if (opcoes.envio === "sem_config") return { ok: false, error: "not_configured" as const };
      enviados.push({ to: a.to, subject: a.subject, html: a.html, text: a.text });
      return { ok: true, id: "m1" };
    }),
    marca: async () => MARCA,
    appUrl: "https://crm.exemplo.test",
    agora: () => agora,
    limitar: async (bucket, limite, janela) => {
      const n = (contadores.get(bucket) ?? 0) + 1;
      contadores.set(bucket, n);
      return { allowed: n <= limite, count: n, limit: limite, window_sec: janela };
    },
    auditar: vi.fn(async (e) => {
      auditorias.push(e as unknown as Record<string, unknown>);
    }),
  };

  return {
    f,
    deps,
    enviados,
    auditorias,
    contadores,
    avancar: (ms: number) => {
      agora = new Date(agora.getTime() + ms);
    },
    /** Zera só o contador do minuto (a janela de 60 s virou), mantendo o do dia. */
    virarOMinuto: () => {
      for (const k of [...contadores.keys()]) if (k.includes(":min:")) contadores.delete(k);
    },
  };
}

describe("cadastro: o e-mail sai com o link de uso único", () => {
  it("manda para o endereço da conta, com o link /auth/verificar-email?token= que de fato verifica", async () => {
    const m = montar();
    const r = await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    expect(r).toEqual({ ok: true });

    expect(m.enviados).toHaveLength(1);
    const e = m.enviados[0]!;
    expect(e.to).toBe("Dono@Exemplo.test");
    expect(e.subject).toBe("Confirme seu e-mail no HiperCRM");
    const link = /https:\/\/crm\.exemplo\.test\/auth\/verificar-email\?token=([^"&\s]+)/.exec(e.html);
    expect(link).not.toBeNull();
    expect(e.text).toContain("/auth/verificar-email?token=");
    expect(e.html).toContain("7 dias");

    // O link do e-mail funciona de verdade contra o que foi gravado.
    const token = decodeURIComponent(link![1]!);
    expect(lerToken(token)?.userId).toBe(USER);
    expect(emailVerificado(m.f.appMetadata(USER))).toBe(false);
    const consumo = await consumirToken({ admin: m.f.cliente, token, agora: new Date(T0.getTime() + 3600_000) });
    expect(consumo.ok).toBe(true);
    expect(emailVerificado(m.f.appMetadata(USER))).toBe(true);
  });

  it("grava junto o que o cadastro pediu (aceite dos Termos) na mesma chamada", async () => {
    const m = montar();
    await enviarVerificacaoDeEmail(
      { userId: USER, via: "cadastro", junto: { aceite_termos: { versao: "2026-10-14", aceito_em: T0.toISOString() } } },
      m.deps,
    );
    expect(m.f.appMetadata(USER).aceite_termos).toEqual({ versao: "2026-10-14", aceito_em: T0.toISOString() });
    expect(pedidoEmAberto(m.f.appMetadata(USER))).not.toBeNull();
    expect(m.f.escritas).toHaveLength(1);
  });

  it("a auditoria leva o hash do endereço e a via, nunca o endereço nem o token", async () => {
    const m = montar();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro", requestId: "req-1" }, m.deps);
    expect(m.auditorias).toHaveLength(1);
    const a = m.auditorias[0]!;
    expect(a.action).toBe("auth.email_verification_sent");
    expect(a.actorUserId).toBe(USER);
    expect((a.metadata as Record<string, unknown>).via).toBe("cadastro");
    expect(JSON.stringify(a)).not.toContain("exemplo.test");
    expect(JSON.stringify(a)).not.toMatch(/token/i);
  });

  it("falha de envio NUNCA lança: devolve o motivo, e o pedido fica gravado para o Reenviar", async () => {
    const m = montar({ envio: "falha" });
    const r = await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    expect(r).toEqual({ ok: false, motivo: "envio_falhou" });
    expect(pedidoEmAberto(m.f.appMetadata(USER))).not.toBeNull();
    expect(m.auditorias).toHaveLength(0);
  });

  it("instalação sem e-mail configurado: motivo próprio, sem lançar", async () => {
    const m = montar({ envio: "sem_config" });
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps)).toEqual({
      ok: false,
      motivo: "email_nao_configurado",
    });
  });

  it("o cadastro não passa pelos tetos do reenvio", async () => {
    const m = montar();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    expect(m.contadores.size).toBe(0);
  });
});

describe("reenvio: 1 por minuto e 5 por dia", () => {
  const pendente = () => {
    const m = montar();
    return m;
  };

  it("os tetos são os combinados", () => {
    expect(LIMITES_DO_REENVIO.porMinuto).toEqual({ max: 1, janelaSeg: 60 });
    expect(LIMITES_DO_REENVIO.porDia).toEqual({ max: 5, janelaSeg: 86_400 });
  });

  it("o segundo pedido dentro do mesmo minuto é barrado, e só o primeiro e-mail sai", async () => {
    const m = pendente();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    m.avancar(61_000);
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({ ok: true });
    m.avancar(5_000);
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({
      ok: false,
      motivo: "muito_cedo",
    });
    expect(m.enviados).toHaveLength(2);
  });

  it("o minuto também vale sem o limitador: o último envio gravado no pedido segura o pedido seguinte", async () => {
    const m = pendente();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    m.avancar(10_000);
    m.virarOMinuto(); // o contador do minuto reiniciou (ex.: Redis reiniciado), mas o pedido lembra
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({
      ok: false,
      motivo: "muito_cedo",
    });
    expect(m.enviados).toHaveLength(1);
  });

  it("a sexta tentativa do dia é barrada, mesmo com o minuto livre", async () => {
    const m = pendente();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    for (let i = 0; i < 5; i++) {
      m.avancar(61_000);
      m.virarOMinuto();
      expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({ ok: true });
    }
    m.avancar(61_000);
    m.virarOMinuto();
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({
      ok: false,
      motivo: "limite_diario",
    });
    expect(m.enviados).toHaveLength(1 + 5);
  });

  it("o teto é por usuário: outro usuário não gasta o orçamento deste", async () => {
    const m = pendente();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    m.avancar(61_000);
    await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps);
    const chaves = [...m.contadores.keys()];
    expect(chaves.every((k) => k.includes(USER))).toBe(true);
  });

  it("conta que já existia (sem pedido em aberto) recebe 'ja_verificado' e nenhum e-mail sai", async () => {
    const m = montar({ appMetadata: { provider: "google", providers: ["google"] } });
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({
      ok: false,
      motivo: "ja_verificado",
    });
    expect(m.enviados).toHaveLength(0);
    expect(m.f.escritas).toHaveLength(0);
  });

  it("conta já confirmada: 'ja_verificado'", async () => {
    const m = montar({ appMetadata: { email_verificado_em: T0.toISOString() } });
    expect(await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps)).toEqual({
      ok: false,
      motivo: "ja_verificado",
    });
    expect(m.enviados).toHaveLength(0);
  });

  it("o link novo troca o antigo: só o do último e-mail verifica", async () => {
    const m = pendente();
    await enviarVerificacaoDeEmail({ userId: USER, via: "cadastro" }, m.deps);
    m.avancar(61_000);
    await enviarVerificacaoDeEmail({ userId: USER, via: "reenvio" }, m.deps);

    const tokenDe = (html: string) => decodeURIComponent(/token=([^"&\s]+)/.exec(html)![1]!);
    const [antigo, novo] = m.enviados.map((e) => tokenDe(e.html));
    const depois = new Date(T0.getTime() + 3600_000);
    expect((await consumirToken({ admin: m.f.cliente, token: antigo, agora: depois })).ok).toBe(false);
    expect((await consumirToken({ admin: m.f.cliente, token: novo, agora: depois })).ok).toBe(true);
  });
});
