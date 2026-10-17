/**
 * `cpf_hash` é um HMAC com a chave do servidor, não um SHA-256 puro (que se desfaz por força bruta no espaço
 * pequeno de CPFs), e nenhuma resposta da API carrega o hash. Sem a chave, o CPF não é gravado.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chaveDoCpfConfigurada, hashCpf } from "@/lib/contacts/cpf";
import { semHashDeCpf } from "@/app/api/v1/contacts/_handler";
import { gravarCpfDoContato } from "@/lib/webhooks/cpf-da-captacao";

const CPF = "529.982.247-25";
const CHAVE_A = "chave-do-servidor-a";
const CHAVE_B = "chave-do-servidor-b";

describe("hashCpf", () => {
  it("não é o SHA-256 puro dos dígitos (quem tem só a coluna não refaz a conta)", () => {
    const hash = hashCpf(CPF, CHAVE_A)!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(createHash("sha256").update("52998224725").digest("hex"));
  });

  it("é estável para o mesmo CPF com ou sem pontuação, e muda com a chave", () => {
    expect(hashCpf("52998224725", CHAVE_A)).toBe(hashCpf(CPF, CHAVE_A));
    expect(hashCpf(CPF, CHAVE_A)).not.toBe(hashCpf(CPF, CHAVE_B));
  });

  it("sem a chave do servidor devolve null (falha fechada)", () => {
    expect(hashCpf(CPF, "")).toBeNull();
    expect(hashCpf(CPF, "   ")).toBeNull();
    expect(chaveDoCpfConfigurada("")).toBe(false);
    expect(chaveDoCpfConfigurada(CHAVE_A)).toBe(true);
  });
});

describe("a API não devolve o hash", () => {
  it("semHashDeCpf tira cpf_hash e deixa só o booleano", () => {
    const comCpf = semHashDeCpf({ id: "c1", cpf_hash: "abc" });
    expect(comCpf).toEqual({ id: "c1", cpf_available: true });
    expect("cpf_hash" in comCpf).toBe(false);
    expect(semHashDeCpf({ id: "c2", cpf_hash: null })).toEqual({ id: "c2", cpf_available: false });
  });
});

describe("CPF da captação sem a chave do servidor", () => {
  const original = process.env.CPF_ENCRYPTION_KEY;
  beforeEach(() => {
    delete process.env.CPF_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CPF_ENCRYPTION_KEY;
    else process.env.CPF_ENCRYPTION_KEY = original;
  });

  it("não grava o CPF e não consulta duplicidade com hash inventado", async () => {
    const update = vi.fn();
    const consultas: string[] = [];
    const construtor = (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "neq", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { id: "c1", cpf_hash: null, is_anonymized: false }, error: null });
      b.update = (...a: unknown[]) => {
        update(...a);
        return b;
      };
      consultas.push(tabela);
      return b;
    };
    const admin = { from: construtor, rpc: vi.fn() } as never;

    const r = await gravarCpfDoContato(admin, { organizationId: "o1", contactId: "c1", cpf: "52998224725" });

    expect(r).toBe("sem_chave_de_cifra");
    expect(update).not.toHaveBeenCalled();
  });
});
