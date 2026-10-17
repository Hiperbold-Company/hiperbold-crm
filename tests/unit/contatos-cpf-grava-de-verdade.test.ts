// @vitest-environment node
/**
 * CPF gravado de verdade pela API de contatos e pela importação (D-216 + correção da RPC `encrypt_cpf`).
 *
 * A RPC `encrypt_cpf` nunca existiu no schema, então `cpf_encrypted` ficava nulo e a constraint
 * `contacts_cpf_consistency` reprovava o `cpf_hash` sozinho: gravar CPF por esses caminhos dava 500. Agora o servidor
 * cifra com `fn_encrypt_oauth` (a mesma da captação) e grava o par `cpf_hash` + `cpf_encrypted` junto.
 *
 * Dois bancos em memória sobre as MESMAS tabelas: o do usuário (RLS à parte, mas que recusa qualquer escrita nas duas
 * colunas, como o grant por coluna da 0967) e o do servidor. As constraints `contacts_cpf_consistency` e
 * `uniq_contacts_org_cpf` são reproduzidas na escrita.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const USER = "c05e7a00-0000-4000-8000-0000000000a1";
const CPF = "52998224725";
const OUTRO_CPF = "11144477735";
const PHONE = "+5511999998888";

process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-cpf";

let usuario: BancoEmMemoria;
let servidor: BancoEmMemoria;
let cifraDisponivel = true;
let sequencia = 0;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => servidor }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => usuario }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: vi.fn(),
  sessaoProntaParaEnvio: vi.fn(async () => null),
}));

import { createContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { POST as importar } from "@/app/api/v1/contacts/import/route";
import { requireRole } from "@/lib/auth/require-role";
import { hashCpf } from "@/lib/contacts/cpf";

const ctx = { organization_id: ORG, actor: { type: "user" as const, id: USER }, requestId: "req" };

/** A constraint `contacts_cpf_consistency` e o índice único `uniq_contacts_org_cpf`, sobre a linha resultante. */
function constraintsDoBanco(todas: Linha[], resultante: Linha, ignorar?: Linha) {
  if ((resultante.cpf_hash == null) !== (resultante.cpf_encrypted == null)) {
    return { message: 'new row violates check constraint "contacts_cpf_consistency"', code: "23514" };
  }
  if (
    resultante.cpf_hash != null &&
    todas.some(
      (l) => l !== ignorar && l.organization_id === resultante.organization_id && l.cpf_hash === resultante.cpf_hash,
    )
  ) {
    return { message: 'duplicate key value violates unique constraint "uniq_contacts_org_cpf"', code: "23505" };
  }
  return null;
}

function montar(inicial: Linha[] = []) {
  const tabelas: Record<string, Linha[]> = {
    contacts: inicial,
    organizations: [{ id: ORG, country: null }],
  };
  const comum = (recusarCpf: boolean) => ({
    contacts: (modo: string, linhas: Linha[], patch?: Linha | null) => {
      if (recusarCpf) {
        // INSERT: as linhas novas; UPDATE: só o que o patch escreve (as linhas casadas já podem ter o CPF).
        const escrito = modo === "insert" ? linhas : patch ? [patch] : [];
        const toca = escrito.some((l) => "cpf_hash" in l || "cpf_encrypted" in l);
        if (toca) return { message: "permission denied for table contacts", code: "42501" };
      }
      if (modo === "insert") {
        for (const l of linhas) l.id ??= `contato-${++sequencia}`;
        for (const l of linhas) {
          const erro = constraintsDoBanco(tabelas.contacts!, l);
          if (erro) return erro;
        }
      }
      if (modo === "update" && patch) {
        for (const l of linhas) {
          const erro = constraintsDoBanco(tabelas.contacts!, { ...l, ...patch }, l);
          if (erro) return erro;
        }
      }
      return null;
    },
  });
  const rpc = {
    fn_encrypt_oauth: (args: Record<string, unknown>) =>
      cifraDisponivel ? { data: `cifrado(${args.plaintext as string})` } : { error: { message: "chave ausente" } },
  };
  usuario = criarBancoEmMemoria(tabelas, { aoEscrever: comum(true) });
  servidor = criarBancoEmMemoria(tabelas, { aoEscrever: comum(false), rpc });
  return tabelas;
}

const contatos = () => usuario.tabelas.contacts!;

beforeEach(() => {
  sequencia = 0;
  cifraDisponivel = true;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "operador@example.com",
      full_name: "Operador",
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: ORG, name: "Org", role: "agent" },
  });
});

describe("criar contato com CPF", () => {
  it("grava cpf_hash e cpf_encrypted juntos, com o CPF cifrado pelo servidor", async () => {
    montar();
    const r = await createContactHandler(usuario as never, ctx, { name: "Maria", cpf: CPF, source: "manual" } as never);

    expect(contatos()).toHaveLength(1);
    expect(contatos()[0]).toMatchObject({ cpf_hash: hashCpf(CPF), cpf_encrypted: `cifrado(${CPF})` });
    expect(r.contact.cpf_available).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CPF);
  });

  it("CPF formatado é cifrado só com os dígitos", async () => {
    montar();
    await createContactHandler(usuario as never, ctx, { name: "Maria", cpf: "529.982.247-25", source: "manual" } as never);
    expect(contatos()[0]?.cpf_encrypted).toBe(`cifrado(${CPF})`);
  });

  it("sem a chave de cifra do banco: 503 cpf_indisponivel e nenhum contato é criado", async () => {
    montar();
    cifraDisponivel = false;
    const erro = await createContactHandler(usuario as never, ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(503);
    expect(contatos()).toHaveLength(0);
  });

  it("CPF que já é de outro contato da organização: 500 como sempre foi e o contato novo é desfeito", async () => {
    montar([
      { id: "existente", organization_id: ORG, name: "Ana", cpf_hash: hashCpf(CPF), cpf_encrypted: "cifrado(x)" },
    ]);
    const erro = await createContactHandler(usuario as never, ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(
      (e: unknown) => e,
    );
    expect((erro as ApiError).status).toBe(500);
    expect(contatos().map((c) => c.id)).toEqual(["existente"]);
  });
});

describe("alterar o CPF de um contato", () => {
  it("grava o par hash + cifrado no contato existente", async () => {
    montar([{ id: "c1", organization_id: ORG, name: "Maria", tags: [], consent: {}, custom_fields: {}, is_anonymized: false }]);
    const r = await patchContactHandler(usuario as never, ctx, "c1", { cpf: CPF } as never);

    expect(contatos()[0]).toMatchObject({ cpf_hash: hashCpf(CPF), cpf_encrypted: `cifrado(${CPF})` });
    expect(r.cpf_available).toBe(true);
  });

  it("troca o CPF: hash e cifrado novos juntos", async () => {
    montar([
      {
        id: "c1",
        organization_id: ORG,
        name: "Maria",
        tags: [],
        consent: {},
        custom_fields: {},
        is_anonymized: false,
        cpf_hash: hashCpf(CPF),
        cpf_encrypted: `cifrado(${CPF})`,
      },
    ]);
    await patchContactHandler(usuario as never, ctx, "c1", { cpf: OUTRO_CPF } as never);
    expect(contatos()[0]).toMatchObject({ cpf_hash: hashCpf(OUTRO_CPF), cpf_encrypted: `cifrado(${OUTRO_CPF})` });
  });

  it("sem a chave de cifra: 503 antes de alterar qualquer campo", async () => {
    montar([{ id: "c1", organization_id: ORG, name: "Maria", tags: [], consent: {}, custom_fields: {}, is_anonymized: false }]);
    cifraDisponivel = false;
    const erro = await patchContactHandler(usuario as never, ctx, "c1", { name: "Nova", cpf: CPF } as never).catch(
      (e: unknown) => e,
    );
    expect((erro as ApiError).status).toBe(503);
    expect(contatos()[0]?.name).toBe("Maria");
  });
});

describe("importação com CPF", () => {
  async function importarCsv(linhas: string[]) {
    const form = new FormData();
    form.set("file", new File([["nome,telefone,cpf", ...linhas].join("\n")], "contatos.csv", { type: "text/csv" }));
    const r = await importar(new NextRequest("http://localhost/api/v1/contacts/import", { method: "POST", body: form }));
    return { status: r.status, corpo: (await r.json()) as { data: { imported: number; skipped_duplicates: number; errors: unknown[] } } };
  }

  it("grava o CPF cifrado junto do hash em cada contato importado", async () => {
    montar();
    const { status, corpo } = await importarCsv([`Ana,${PHONE},${CPF}`]);

    expect(status).toBe(200);
    expect(corpo.data).toMatchObject({ imported: 1, skipped_duplicates: 0, errors: [] });
    expect(contatos()).toHaveLength(1);
    expect(contatos()[0]).toMatchObject({ cpf_hash: hashCpf(CPF), cpf_encrypted: `cifrado(${CPF})` });
  });

  it("CPF que já existe na organização conta como duplicado e não deixa contato sem CPF para trás", async () => {
    montar([
      { id: "existente", organization_id: ORG, name: "Zé", phone_number: "+5521988887777", cpf_hash: hashCpf(CPF), cpf_encrypted: "cifrado(x)" },
    ]);
    const { corpo } = await importarCsv([`Ana,${PHONE},${CPF}`]);

    expect(corpo.data).toMatchObject({ imported: 0, skipped_duplicates: 1, errors: [] });
    expect(contatos().map((c) => c.id)).toEqual(["existente"]);
  });

  it("sem a chave de cifra a linha vai para os erros e nada é criado", async () => {
    montar();
    cifraDisponivel = false;
    const { corpo } = await importarCsv([`Ana,${PHONE},${CPF}`]);

    expect(corpo.data.imported).toBe(0);
    expect(corpo.data.errors).toHaveLength(1);
    expect(contatos()).toHaveLength(0);
  });
});
