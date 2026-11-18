import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { baseDoWebhookDaSessao, webhookDaSessaoWaha } from "./webhook-da-sessao-waha";

/**
 * O webhook por sessão: URL pública + segredo da sessão, gravado CIFRADO antes
 * de ir ao WAHA, e nunca em log. O banco é um dublê que guarda o que foi
 * escrito; a cifra é um dublê reversível que marca o texto cifrado.
 */

const ORG = "org-1";
const SESSAO = "sess-1";
const TOKEN = "token-da-sessao-0001";

function banco(linha: { webhook_path_token: string | null; webhook_secret_encrypted: string | null }, opcoes: {
  decifraFalha?: boolean; cifraIndisponivel?: boolean;
  /** Outra reconexão gravou ESTE cifrado entre a nossa leitura e o nosso UPDATE. */
  gravadoPorOutro?: string;
  /** O filtro do compare-and-set nunca casa (o UPDATE atinge 0 linhas) e nada mudou no banco. */
  filtroNuncaCasa?: boolean;
} = {}) {
  const escritas: Record<string, unknown>[] = [];
  const filtrosDaEscrita: Array<[string, unknown]> = [];
  const cifrados: string[] = [];
  const lidas = { n: 0 };
  // O valor que o BANCO tem agora: muda com a escrita do "outro" logo depois da
  // primeira leitura, e com as escritas que o filtro deixar passar.
  let armazenado = linha.webhook_secret_encrypted;
  const db = {
    from: vi.fn(() => {
      let pendente: Record<string, unknown> | null = null;
      const filtros: Array<[string, unknown]> = [];
      const b = {
        select: () => b,
        update: (row: Record<string, unknown>) => { pendente = row; return b; },
        eq: (coluna: string, valor: unknown) => {
          if (pendente) { filtrosDaEscrita.push([coluna, valor]); filtros.push([coluna, valor]); }
          return b;
        },
        maybeSingle: async () => {
          if (pendente) {
            // O UPDATE honra o filtro da coluna do segredo de verdade (compare-and-set).
            const cas = filtros.find(([c]) => c === "webhook_secret_encrypted");
            if (opcoes.filtroNuncaCasa || (cas && cas[1] !== armazenado)) return { data: null, error: null };
            escritas.push(pendente);
            armazenado = pendente.webhook_secret_encrypted as string;
            return { data: { id: SESSAO }, error: null };
          }
          lidas.n++;
          const atual = { ...linha, webhook_secret_encrypted: armazenado };
          if (lidas.n === 1 && opcoes.gravadoPorOutro) armazenado = opcoes.gravadoPorOutro;
          return { data: atual, error: null };
        },
      };
      return b;
    }),
    rpc: vi.fn(async (nome: string, args: Record<string, string | undefined>) => {
      if (nome === "fn_encrypt_oauth") {
        if (opcoes.cifraIndisponivel) return { data: null, error: { message: "sem chave" } };
        cifrados.push(args.plaintext ?? "");
        return { data: `\\xCIFRADO(${Buffer.from(args.plaintext ?? "").toString("hex")})`, error: null };
      }
      if (nome === "fn_decrypt_oauth") {
        if (opcoes.decifraFalha) return { data: null, error: { message: "boom" } };
        if (/^\\x0*$/.test(args.ciphertext ?? "")) return { data: null, error: null };
        return { data: "segredo-existente-bem-longo-000000", error: null };
      }
      return { data: null, error: null };
    }),
  } as unknown as SupabaseClient & { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
  return { db, escritas, filtrosDaEscrita, cifrados, lidas };
}

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  avisos = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  avisos.mockRestore();
});

describe("baseDoWebhookDaSessao", () => {
  it("vazia = null", () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "");
    expect(baseDoWebhookDaSessao()).toBeNull();
  });
  it("https vale, sem barra final", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br/");
    expect(baseDoWebhookDaSessao()).toBe("https://crm.exemplo.com.br");
  });
  it("http em produção (o `http://app:3000` do kit) NÃO registra — o kit segue pelo webhook global", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "http://app:3000");
    expect(baseDoWebhookDaSessao()).toBeNull();
  });
  it("http fora de produção é aceito (desenvolvimento)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "http://host.docker.internal:3000");
    expect(baseDoWebhookDaSessao()).toBe("http://host.docker.internal:3000");
  });
});

describe("webhookDaSessaoWaha", () => {
  it("sem base, devolve null sem tocar no banco", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" });
    await expect(webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO })).resolves.toBeNull();
    expect(b.db.from).not.toHaveBeenCalled();
    expect(b.db.rpc).not.toHaveBeenCalled();
  });

  it("placeholder: gera segredo forte, grava CIFRADO (filtrado por org) e o usa como chave; nunca vai a log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" });
    const w = await webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO });
    expect(w).not.toBeNull();
    expect(w!.url).toBe(`https://crm.exemplo.com.br/api/v1/webhooks/waha/${TOKEN}`);
    expect(w!.hmacKey).toMatch(/^[0-9a-f]{64}$/);
    // O que foi gravado é o retorno da cifra, nunca o texto claro.
    expect(b.cifrados).toEqual([w!.hmacKey]);
    expect(b.escritas).toHaveLength(1);
    const gravado = b.escritas[0]!.webhook_secret_encrypted as string;
    expect(gravado.startsWith("\\xCIFRADO(")).toBe(true);
    expect(gravado).not.toContain(w!.hmacKey);
    expect(b.filtrosDaEscrita).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", SESSAO]]));
    expect(JSON.stringify(avisos.mock.calls)).not.toContain(w!.hmacKey);
  });

  it("segredo já bom: reaproveita (não troca a assinatura em voo) e não grava nada", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\xabcdef" });
    const w = await webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO });
    expect(w?.hmacKey).toBe("segredo-existente-bem-longo-000000");
    expect(b.escritas).toHaveLength(0);
  });

  it("decifra que FALHA (passageira) não gera segredo novo: devolve null e não grava", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\xabcdef" }, { decifraFalha: true });
    await expect(webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO })).resolves.toBeNull();
    expect(b.escritas).toHaveLength(0);
  });

  it("cifra indisponível: não manda ao WAHA uma chave que o banco não guarda", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" }, { cifraIndisponivel: true });
    await expect(webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO })).resolves.toBeNull();
    expect(b.escritas).toHaveLength(0);
  });

  it("sessão sem token: null", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: null, webhook_secret_encrypted: "\\x00" });
    await expect(webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO })).resolves.toBeNull();
  });

  it("compare-and-set: o UPDATE só grava sobre o placeholder, filtrado por org, id e provider", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" });
    const w = await webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO });
    expect(w?.hmacKey).toMatch(/^[0-9a-f]{64}$/);
    expect(b.filtrosDaEscrita).toEqual(expect.arrayContaining([
      ["organization_id", ORG], ["id", SESSAO], ["provider", "waha"], ["webhook_secret_encrypted", "\\x00"],
    ]));
  });

  it("corrida: outra reconexão gravou antes — usa o segredo JÁ gravado, não sobrescreve", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" }, { gravadoPorOutro: "\\xvencedor" });
    const w = await webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO });
    // O dublê decifra qualquer cifrado não-placeholder para este valor: o do vencedor.
    expect(w?.hmacKey).toBe("segredo-existente-bem-longo-000000");
    expect(b.escritas).toHaveLength(0);
  });

  it("UPDATE com 0 linhas e o banco AINDA no placeholder: não registra (log próprio, distinto da corrida)", async () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
    const b = banco({ webhook_path_token: TOKEN, webhook_secret_encrypted: "\\x00" }, { filtroNuncaCasa: true });
    await expect(webhookDaSessaoWaha(b.db, { organizationId: ORG, channelSessionId: SESSAO })).resolves.toBeNull();
    expect(JSON.stringify(avisos.mock.calls)).toContain("compare-and-set não casou");
  });
});
