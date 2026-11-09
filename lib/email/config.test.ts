/**
 * A linha de `platform_smtp_settings` fica 5 min em memória (o cron
 * `enviar-emails-de-conta` perguntava por ela a cada minuto), sem trocar a
 * resposta de ninguém: quem grava invalida, erro do banco não é guardado, e a
 * senha só é decifrada depois do cache (o texto claro nunca fica nele).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerTudo } from "@/lib/auth/cache-curto";

const h = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  erro: null as { message: string } | null,
  lanca: false,
  leituras: 0,
  gravacoes: 0,
  decifradas: [] as string[],
}));

vi.mock("@/lib/env", () => ({
  env: {
    SMTP_HOST: "",
    SMTP_PORT: 587,
    SMTP_SECURITY: "starttls",
    SMTP_USERNAME: "",
    SMTP_PASSWORD: "",
    SMTP_FROM_EMAIL: "",
    SMTP_FROM_NAME: "",
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) => {
    h.decifradas.push(cifrado);
    return `claro:${cifrado}`;
  },
  encryptWebhookSecret: async (_admin: unknown, claro: string) => `cifrado:${claro}`,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            h.leituras += 1;
            if (h.lanca) throw new Error("rede fora");
            return { data: h.linha, error: h.erro };
          },
        }),
      }),
      upsert: async () => {
        h.gravacoes += 1;
        return { error: null };
      },
    }),
  }),
}));

const { getSmtpConfig, lerSmtp, saveSmtpConfig } = await import("@/lib/email/config");

const LINHA = {
  smtp_host: "smtp.exemplo.com",
  smtp_port: 465,
  smtp_security: "tls",
  smtp_username: "usuario",
  smtp_password_encrypted: "segredo",
  from_email: "oi@exemplo.com",
  from_name: "Exemplo",
};

beforeEach(() => {
  esquecerTudo();
  h.linha = null;
  h.erro = null;
  h.lanca = false;
  h.leituras = 0;
  h.gravacoes = 0;
  h.decifradas = [];
});

describe("leitura de platform_smtp_settings atrás do cache curto", () => {
  it("duas leituras seguidas vão ao banco UMA vez, com ou sem linha", async () => {
    await getSmtpConfig();
    await getSmtpConfig();
    expect(h.leituras).toBe(1);

    esquecerTudo();
    h.leituras = 0;
    h.linha = LINHA;
    const a = await getSmtpConfig();
    const b = await getSmtpConfig();
    expect(h.leituras).toBe(1);
    expect(a).toMatchObject({ host: "smtp.exemplo.com", source: "database", password: "claro:segredo" });
    expect(b).toEqual(a);
  });

  it("a senha é decifrada a cada leitura: o texto claro não fica no cache", async () => {
    h.linha = LINHA;
    await getSmtpConfig();
    await getSmtpConfig();
    expect(h.decifradas).toEqual(["segredo", "segredo"]);
  });

  it("gravar pela tela invalida: a leitura seguinte já enxerga o servidor novo", async () => {
    h.linha = null;
    expect((await getSmtpConfig()).source).toBe("none");

    h.linha = LINHA;
    const salvo = await saveSmtpConfig({
      host: "smtp.exemplo.com",
      port: 465,
      security: "tls",
      username: "usuario",
      password: "nova",
      fromEmail: "oi@exemplo.com",
      fromName: "Exemplo",
      updatedBy: "u1",
    });
    expect(salvo.ok).toBe(true);
    expect(h.gravacoes).toBe(1);
    expect(await getSmtpConfig()).toMatchObject({ source: "database", host: "smtp.exemplo.com" });
  });

  it("erro do banco não é guardado: o soluço não vira 5 min de transporte errado", async () => {
    h.erro = { message: "PGRST002" };
    const caiu = await lerSmtp();
    expect(caiu).toMatchObject({ bancoRespondeu: false, config: { source: "none" } });

    h.erro = null;
    h.linha = LINHA;
    const voltou = await lerSmtp();
    expect(voltou).toMatchObject({ bancoRespondeu: true, config: { source: "database" } });
    expect(h.leituras).toBe(2);
  });

  it("exceção do client (rede) também não é guardada", async () => {
    h.lanca = true;
    expect(await lerSmtp()).toMatchObject({ bancoRespondeu: false });
    h.lanca = false;
    h.linha = LINHA;
    expect(await lerSmtp()).toMatchObject({ bancoRespondeu: true });
  });

  it("'sem linha' guardado continua dizendo que o banco respondeu (o esqueci-a-senha depende disso)", async () => {
    expect(await lerSmtp()).toMatchObject({ bancoRespondeu: true, config: { source: "none" } });
    expect(await lerSmtp()).toMatchObject({ bancoRespondeu: true, config: { source: "none" } });
    expect(h.leituras).toBe(1);
  });
});
