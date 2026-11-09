/**
 * O memo de 30 s da configuração da instalação (`valorDaInstalacao` / `lerLinha`).
 *
 * Comportamento, não implementação: o banco é dublado e o que se mede é QUANTAS
 * vezes ele é consultado e o que o chamador enxerga — dentro do prazo, depois de
 * uma escrita, depois do prazo, depois de um erro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: new Map<string, Record<string, unknown>>(),
  leituras: 0,
  falhar: false,
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (v: string) => ({
    ciphertext: Buffer.from(v),
    iv: Buffer.from("iv"),
    tag: Buffer.from("tag"),
    last4: v.slice(-4),
  }),
  decryptKey: (e: { ciphertext: Buffer }) => e.ciphertext.toString(),
  bufToBytea: (b: Buffer) => `\\x${b.toString("hex")}`,
  byteaToBuffer: (s: string) => Buffer.from(s.slice(2), "hex"),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let chave = "";
      const q = {
        upsert: async (linha: Record<string, unknown>) => {
          h.linhas.set(String(linha.chave), linha);
          return { error: null };
        },
        delete: () => q,
        select: () => q,
        eq: (_k: string, v: string) => {
          chave = v;
          return q;
        },
        abortSignal: () => q,
        maybeSingle: async () => {
          h.leituras += 1;
          if (h.falhar) return { data: null, error: { message: "banco fora" } };
          return { data: h.linhas.get(chave) ?? null, error: null };
        },
        then: (ok: (v: unknown) => unknown) => {
          h.linhas.delete(chave);
          return Promise.resolve({ error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { TTL_CURTO_MS } from "@/lib/auth/cache-curto";

import { estadoParaTela, gravarPelaTela, valorDaInstalacao, voltarAoAmbiente } from "./config";

function linha(chave: string, valor: string) {
  return { chave, valor, ciphertext: null, iv: null, tag: null, last4: null, eh_segredo: false, semeado_do_env: false };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  h.linhas.clear();
  h.leituras = 0;
  h.falhar = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.MEMO_DA_INSTALACAO_MS;
});

describe("valorDaInstalacao — memo de 30 s", () => {
  it("a segunda leitura dentro do prazo não vai ao banco", async () => {
    h.linhas.set("RESEND_FROM_EMAIL", linha("RESEND_FROM_EMAIL", "a@x.com"));
    expect((await valorDaInstalacao("RESEND_FROM_EMAIL")).valor).toBe("a@x.com");
    expect((await valorDaInstalacao("RESEND_FROM_EMAIL")).valor).toBe("a@x.com");
    expect(h.leituras).toBe(1);
  });

  it("chaves diferentes não se misturam", async () => {
    h.linhas.set("A", linha("A", "1"));
    h.linhas.set("B", linha("B", "2"));
    expect((await valorDaInstalacao("A")).valor).toBe("1");
    expect((await valorDaInstalacao("B")).valor).toBe("2");
    expect(h.leituras).toBe(2);
  });

  it("vencido o prazo, volta ao banco e enxerga a mudança feita por outro processo", async () => {
    h.linhas.set("A", linha("A", "velho"));
    expect((await valorDaInstalacao("A")).valor).toBe("velho");
    h.linhas.set("A", linha("A", "novo")); // escrita de OUTRO processo: sem invalidação aqui
    vi.advanceTimersByTime(TTL_CURTO_MS - 1);
    expect((await valorDaInstalacao("A")).valor).toBe("velho");
    vi.advanceTimersByTime(2);
    expect((await valorDaInstalacao("A")).valor).toBe("novo");
    expect(h.leituras).toBe(2);
  });

  it("gravar pela tela invalida: a leitura seguinte já vê o valor novo", async () => {
    h.linhas.set("A", linha("A", "velho"));
    expect((await valorDaInstalacao("A")).valor).toBe("velho");
    expect(await gravarPelaTela("A", "novo", { ehSegredo: false, ator: null })).toEqual({ ok: true });
    expect((await valorDaInstalacao("A")).valor).toBe("novo");
    expect(h.leituras).toBe(2);
  });

  it("gravar um segredo pela tela: a leitura seguinte devolve o novo, decifrado", async () => {
    expect((await valorDaInstalacao("SEGREDO")).valor).toBeNull(); // memoiza "sem linha"
    await gravarPelaTela("SEGREDO", "chave-nova-1234", { ehSegredo: true, ator: null });
    expect((await valorDaInstalacao("SEGREDO")).valor).toBe("chave-nova-1234");
  });

  it("voltar ao ambiente invalida: a linha apagada deixa de valer na hora", async () => {
    h.linhas.set("A", linha("A", "da-tela"));
    expect((await valorDaInstalacao("A")).valor).toBe("da-tela");
    expect(await voltarAoAmbiente("A")).toEqual({ ok: true });
    expect((await valorDaInstalacao("A")).valor).toBeNull();
  });

  it("erro do banco não entra no memo: a chamada seguinte tenta de novo", async () => {
    h.linhas.set("A", linha("A", "ok"));
    h.falhar = true;
    expect((await valorDaInstalacao("A")).valor).toBeNull();
    h.falhar = false;
    expect((await valorDaInstalacao("A")).valor).toBe("ok");
    expect(h.leituras).toBe(2);
  });

  it("a tela (estadoParaTela) lê fresco: não serve o memo", async () => {
    h.linhas.set("A", linha("A", "velho"));
    await valorDaInstalacao("A");
    h.linhas.set("A", linha("A", "novo"));
    expect((await estadoParaTela("A", false)).valorVisivel).toBe("novo");
  });

  it("MEMO_DA_INSTALACAO_MS=0 desliga o memo", async () => {
    process.env.MEMO_DA_INSTALACAO_MS = "0";
    h.linhas.set("A", linha("A", "1"));
    await valorDaInstalacao("A");
    await valorDaInstalacao("A");
    expect(h.leituras).toBe(2);
  });
});
