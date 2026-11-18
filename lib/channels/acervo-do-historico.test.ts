import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O PATCH /acervo faz PUT da config da sessão (`convergirConfigDaSessao`), que
 * reenvia o `config.webhooks` lido do GET. Com o webhook da sessão em mãos
 * (url + segredo do banco), a entrada do CRM vai com a chave do banco — e não
 * com a que o GET pode trazer mascarada. O acervo NÃO gera segredo: sessão no
 * placeholder segue sem webhook até a reconexão.
 */

const convergir = vi.fn(async () => true);
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => ({ convergirConfigDaSessao: convergir }) }));

import { salvarAcervoDoCanal } from "./acervo-do-historico";

const ORG = "org-1";
const CANAL = "canal-1";
const TOKEN = "token-do-canal-0001";

function banco(cifrado: string) {
  const escritas: Record<string, unknown>[] = [];
  const db = {
    from: vi.fn(() => {
      let pendente: Record<string, unknown> | null = null;
      const b = {
        select: () => b,
        update: (row: Record<string, unknown>) => { pendente = row; return b; },
        eq: () => b,
        is: () => b,
        maybeSingle: async () => {
          if (pendente) { escritas.push(pendente); return { data: { id: CANAL }, error: null }; }
          return {
            data: { metadata: {}, waha_session_name: "sessao-1", webhook_path_token: TOKEN, webhook_secret_encrypted: cifrado },
            error: null,
          };
        },
      };
      return b;
    }),
    rpc: vi.fn(async (nome: string, args: { ciphertext?: string }) => {
      if (nome === "fn_decrypt_oauth") {
        return /^\\x0*$/.test(args.ciphertext ?? "") ? { data: null, error: null } : { data: "segredo-do-banco-bem-longo-0000", error: null };
      }
      return { data: "\\xNOVO", error: null };
    }),
  } as unknown as SupabaseClient;
  return { db, escritas };
}

beforeEach(() => {
  convergir.mockClear();
  vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.exemplo.com.br");
});
afterEach(() => vi.unstubAllEnvs());

describe("salvarAcervoDoCanal: o PUT leva o webhook da sessão", () => {
  it("sessão com segredo: convergir recebe o webhook (url do token + chave do banco)", async () => {
    const { db } = banco("\\xc30d0407");
    await salvarAcervoDoCanal(db, ORG, CANAL, true);
    expect(convergir).toHaveBeenCalledWith("sessao-1", {
      guardarHistorico: true,
      webhook: { url: `https://crm.exemplo.com.br/api/v1/webhooks/waha/${TOKEN}`, hmacKey: "segredo-do-banco-bem-longo-0000" },
    });
  });

  it("sessão no placeholder: NÃO gera segredo; convergir vai sem webhook (lista preservada)", async () => {
    const { db, escritas } = banco("\\x00");
    await salvarAcervoDoCanal(db, ORG, CANAL, false);
    expect(convergir).toHaveBeenCalledWith("sessao-1", { guardarHistorico: false });
    expect(escritas.some((e) => "webhook_secret_encrypted" in e)).toBe(false);
  });
});
