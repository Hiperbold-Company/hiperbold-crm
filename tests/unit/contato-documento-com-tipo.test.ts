// @vitest-environment node
/**
 * O DOCUMENTO DO CONTATO COM TIPO (país Estados Unidos, decisão de 24/11/2026).
 *
 * Mesmo banco em memória de `contatos-cpf-grava-de-verdade.test.ts`: o do
 * usuário recusa escrita no par do CPF (grant por coluna da 0967) e o do
 * servidor grava. Aqui o que se prova é o PAR tipo + número: a validação pelo
 * tipo, o número gravado com letra (sem o `\D` que apagava), o tipo gravado
 * junto, o hash com o tipo, o CSV com coluna de tipo, e o Brasil igual.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const ORG_BR = "c05e7a00-0000-4000-8000-000000000002";
const USER = "c05e7a00-0000-4000-8000-0000000000a1";
const CPF = "52998224725";

process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-cpf";

let orgDaSessao = ORG;
let papelNaOrg = "agent";
import { createContactHandler, getContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { COLUNAS_DO_CONTATO_SEM_CPF } from "@/lib/contacts/colunas";
import { POST as importar } from "@/app/api/v1/contacts/import/route";
import { requireRole } from "@/lib/auth/require-role";
import { hashCpf, hashDocumento } from "@/lib/contacts/cpf";
import { MENSAGEM_SSN, perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { contactCreateSchemaDoPais, contactPatchSchemaDoPais } from "@/lib/schemas/contacts";
import { validateRequest } from "@/lib/schemas/_validate";
import { ApiError } from "@/lib/api/types";

const US = perfilDoPais("US");
const BR = perfilDoPais("BR");
const ctx = { organization_id: ORG, actor: { type: "user" as const, id: USER }, requestId: "req" };

/** O que a rota faz antes do handler: o schema do PAÍS da organização. */
function validado(perfil: typeof US, corpo: Record<string, unknown>) {
  return contactCreateSchemaDoPais(perfil).safeParse({ source: "manual", ...corpo });
}

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
    organizations: [
      { id: ORG, country: "US" },
      { id: ORG_BR, country: null },
    ],
    user_organizations: [{ user_id: USER, organization_id: ORG, role: papelNaOrg, revoked_at: null }],
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
        for (const l of linhas) l.is_anonymized ??= false;
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
    fn_decrypt_oauth: (args: Record<string, unknown>) => {
      const m = /^cifrado\((.*)\)$/.exec(String(args.ciphertext).replace(/^\\x/, ""));
      return m ? { data: m[1] } : { error: { message: "não decifra" } };
    },
  };
  usuario = criarBancoEmMemoria(tabelas, { aoEscrever: comum(true) });
  servidor = criarBancoEmMemoria(tabelas, { aoEscrever: comum(false), rpc });
  return tabelas;
}

const contatos = () => usuario.tabelas.contacts!;

beforeEach(() => {
  orgDaSessao = ORG;
  papelNaOrg = "agent";
  sequencia = 0;
  cifraDisponivel = true;
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user: {
      id: USER,
      email: "operador@example.com",
      full_name: "Operador",
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: orgDaSessao, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: orgDaSessao, name: "Org", role: "agent" },
  }) as never);
});

describe("a API valida o par tipo + número pelo país da organização", () => {
  it("EUA: tipo válido e número na régua do tipo passam", () => {
    const r = validado(US, { name: "Ana", cpf: "A12345678", document_type: "us_passport" });
    expect(r.success).toBe(true);
  });

  it("EUA: número sem tipo é recusado no campo do tipo", () => {
    const r = validado(US, { name: "Ana", cpf: "A12345678" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ["document_type"], message: "Escolha o tipo do documento" });
  });

  it("EUA: SSN como tipo é recusado (não está no vocabulário)", () => {
    const r = validado(US, { name: "Ana", cpf: "123-45-6789", document_type: "us_ssn" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === "document_type")).toBe(true);
  });

  it("EUA: número na forma de SSN é recusado em tipo que não é ITIN, com a mensagem própria", () => {
    const r = validado(US, { name: "Ana", cpf: "123-45-6789", document_type: "us_drivers_license" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ["cpf"], message: MENSAGEM_SSN });
  });

  it("EUA: número fora da régua do tipo é recusado no campo do número", () => {
    const r = validado(US, { name: "Ana", cpf: "812-70-1234", document_type: "us_itin" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["cpf"]);
  });

  it("EUA: CPF de brasileiro em Orlando confere o dígito", () => {
    expect(validado(US, { name: "Ana", cpf: "529.982.247-25", document_type: "br_cpf" }).success).toBe(true);
    expect(validado(US, { name: "Ana", cpf: "529.982.247-24", document_type: "br_cpf" }).success).toBe(false);
  });

  it("EUA: tipo sem número no PATCH é recusado", () => {
    const r = contactPatchSchemaDoPais(US).safeParse({ document_type: "us_passport" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["cpf"]);
  });

  it("Brasil: tipo enviado é recusado, inclusive o implícito; sem tipo, a régua de sempre", () => {
    expect(validado(BR, { name: "Ana", cpf: CPF, document_type: "br_cpf" }).success).toBe(false);
    expect(validado(BR, { name: "Ana", cpf: CPF }).success).toBe(true);
    const ruim = validado(BR, { name: "Ana", cpf: "52998224724" });
    expect(ruim.error?.issues[0]).toMatchObject({ path: ["cpf"], message: "CPF inválido" });
  });

  it("a recusa sai como 422 validation_error com o campo (o contrato real de validateRequest)", async () => {
    const req = new Request("http://localhost/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Ana", cpf: "A12345678", document_type: "us_ssn" }),
    });
    const erro = await validateRequest(contactCreateSchemaDoPais(US), req).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 422, code: "validation_error" });
    expect((erro as ApiError).details).toMatchObject({ fieldErrors: { document_type: expect.any(Array) } });
  });
});

describe("criar e alterar contato com documento tipado", () => {
  it("grava o número COM a letra, o tipo junto, e o hash com o tipo", async () => {
    montar();
    const r = validado(US, { name: "Ana", cpf: "a1234-5678", document_type: "us_passport" });
    expect(r.success).toBe(true);
    await createContactHandler(usuario as never, ctx, r.data as never);

    expect(contatos()).toHaveLength(1);
    expect(contatos()[0]).toMatchObject({
      cpf_encrypted: "cifrado(A12345678)",
      cpf_hash: hashDocumento("A12345678", "us_passport"),
      document_type: "us_passport",
    });
  });

  it("o hash leva o tipo: passaporte e ITIN com os mesmos dígitos não colidem; CPF é o hash de sempre", () => {
    expect(hashDocumento("912701234", "us_passport")).not.toBe(hashDocumento("912701234", "us_itin"));
    expect(hashDocumento(CPF, "br_cpf")).toBe(hashCpf(CPF));
    expect(hashDocumento(CPF, null)).toBe(hashCpf(CPF));
  });

  it("CPF numa organização dos EUA casa com o mesmo CPF já gravado (409, não duplica)", async () => {
    montar([{ id: "antigo", organization_id: ORG, name: "Zé", cpf_hash: hashCpf(CPF), cpf_encrypted: "cifrado(x)" }]);
    const r = validado(US, { name: "Ana", cpf: CPF, document_type: "br_cpf" });
    const erro = await createContactHandler(usuario as never, ctx, r.data as never).catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 409 });
  });

  it("isolamento: o mesmo documento em OUTRA organização não é conflito", async () => {
    montar([
      {
        id: "de-outra-org",
        organization_id: ORG_BR,
        name: "Zé",
        cpf_hash: hashDocumento("A12345678", "us_passport"),
        cpf_encrypted: "cifrado(A12345678)",
        document_type: "us_passport",
      },
    ]);
    const r = validado(US, { name: "Ana", cpf: "A12345678", document_type: "us_passport" });
    await createContactHandler(usuario as never, ctx, r.data as never);
    const daOrg = contatos().filter((c) => c.organization_id === ORG);
    expect(daOrg).toHaveLength(1);
    expect(daOrg[0]).toMatchObject({ document_type: "us_passport" });
    expect(contatos().find((c) => c.id === "de-outra-org")).toMatchObject({ organization_id: ORG_BR });
  });

  it("Brasil: o CPF grava como sempre, com o tipo nulo", async () => {
    montar();
    const r = validado(BR, { name: "Maria", cpf: CPF });
    await createContactHandler(usuario as never, { ...ctx, organization_id: ORG_BR }, r.data as never);
    expect(contatos()[0]).toMatchObject({
      cpf_hash: hashCpf(CPF),
      cpf_encrypted: `cifrado(${CPF})`,
      document_type: null,
    });
  });

  it("trocar o país para EUA não invalida o documento antigo: PATCH de outro campo deixa o par intacto", async () => {
    montar([
      {
        id: "antigo",
        organization_id: ORG,
        name: "Zé",
        is_anonymized: false,
        tags: [],
        consent: {},
        custom_fields: {},
        cpf_hash: hashCpf(CPF),
        cpf_encrypted: `cifrado(${CPF})`,
      },
    ]);
    const r = contactPatchSchemaDoPais(US).safeParse({ name: "José" });
    expect(r.success).toBe(true);
    await patchContactHandler(usuario as never, ctx, "antigo", r.data as never);
    expect(contatos()[0]).toMatchObject({ name: "José", cpf_hash: hashCpf(CPF), cpf_encrypted: `cifrado(${CPF})` });
    expect(contatos()[0]).not.toHaveProperty("document_type");
  });

  it("trocar o documento no PATCH reescreve o tipo junto", async () => {
    montar([
      {
        id: "c1",
        organization_id: ORG,
        name: "Ana",
        is_anonymized: false,
        tags: [],
        consent: {},
        custom_fields: {},
        cpf_hash: hashDocumento("A12345678", "us_passport"),
        cpf_encrypted: "cifrado(A12345678)",
        document_type: "us_passport",
      },
    ]);
    const r = contactPatchSchemaDoPais(US).safeParse({ cpf: "912-70-1234", document_type: "us_itin" });
    expect(r.success).toBe(true);
    await patchContactHandler(usuario as never, ctx, "c1", r.data as never);
    expect(contatos()[0]).toMatchObject({
      cpf_encrypted: "cifrado(912701234)",
      cpf_hash: hashDocumento("912701234", "us_itin"),
      document_type: "us_itin",
    });
  });
});

describe("o tipo tem a visibilidade do número (só gerente+)", () => {
  const passaporte = {
    id: "p1",
    organization_id: ORG,
    name: "Ana",
    is_anonymized: false,
    tags: [],
    consent: {},
    custom_fields: {},
    cpf_hash: "hash-p1",
    cpf_encrypted: "cifrado(A12345678)",
    document_type: "us_passport",
  };

  it("a resposta da criação não traz o tipo", async () => {
    montar();
    const r = validado(US, { name: "Ana", cpf: "A12345678", document_type: "us_passport" });
    const criado = await createContactHandler(usuario as never, ctx, r.data as never);
    expect(contatos()[0]).toMatchObject({ document_type: "us_passport" });
    expect(criado.contact).not.toHaveProperty("document_type");
  });

  it("atendente que pede para abrir o documento é negado, e o tipo não é lido pelo servidor", async () => {
    montar([{ ...passaporte }]);
    const ficha = await getContactHandler(usuario as never, ctx, { contactId: "p1", decryptPurpose: "atendimento" });
    expect(ficha.cpf_available).toBe(true);
    expect(ficha.cpf_decrypt_denied).toBe(true);
    expect(ficha.cpf_decrypted).toBeNull();
    // O banco em memória devolve a linha inteira em qualquer `select`; o recorte real é a lista de
    // colunas da sessão (abaixo) — aqui se prova que o caminho do servidor não acrescentou o tipo.
    expect(servidor.chamadasRpc.some((c) => c.nome === "fn_decrypt_oauth")).toBe(false);
  });

  it("a lista de colunas que a sessão lê (lista, ficha, respostas de POST e PATCH) não nomeia o tipo", () => {
    const fonte = readFileSync(join(process.cwd(), "app/api/v1/contacts/_handler.ts"), "utf8");
    const m = /const SELECT_COLS =\s*"([^"]+)"/.exec(fonte);
    expect(m, "SELECT_COLS não encontrado").not.toBeNull();
    expect(m![1]!.split(", ")).not.toContain("document_type");
    expect(m![1]!.split(", ")).not.toContain("cpf_hash");
  });

  it("gerente que abre o documento recebe o número E o tipo", async () => {
    papelNaOrg = "manager";
    montar([{ ...passaporte }]);
    const ficha = await getContactHandler(usuario as never, ctx, { contactId: "p1", decryptPurpose: "atendimento" });
    expect(ficha.cpf_decrypted).toBe("A12345678");
    expect(ficha.document_type).toBe("us_passport");
  });

  it("o contexto das automações não leva o tipo", () => {
    expect(COLUNAS_DO_CONTATO_SEM_CPF.split(", ")).not.toContain("document_type");
    expect(COLUNAS_DO_CONTATO_SEM_CPF.split(", ")).not.toContain("cpf_hash");
  });
});

describe("importação por planilha com a coluna do tipo", () => {
  async function importarCsv(cabecalho: string, linhas: string[]) {
    const form = new FormData();
    form.set("file", new File([[cabecalho, ...linhas].join("\n")], "contatos.csv", { type: "text/csv" }));
    const r = await importar(new NextRequest("http://localhost/api/v1/contacts/import", { method: "POST", body: form }));
    return {
      status: r.status,
      corpo: (await r.json()) as {
        data: { imported: number; skipped_duplicates: number; errors: Array<{ linha: number; motivo: string }> };
      },
    };
  }

  it("EUA: tipo por código ou por nome; número normalizado e tipo gravado", async () => {
    montar();
    const { corpo } = await importarCsv("name,phone_number,document,document_type", [
      "Ana,+14075551234,A1234-5678,US Passport",
      "Bia,+14075551235,912-70-1234,itin",
      "Caio,+14075551236,529.982.247-25,CPF",
    ]);
    expect(corpo.data).toMatchObject({ imported: 3, errors: [] });
    expect(contatos().map((c) => [c.cpf_encrypted, c.document_type])).toEqual([
      ["cifrado(A12345678)", "us_passport"],
      ["cifrado(912701234)", "us_itin"],
      [`cifrado(${CPF})`, "br_cpf"],
    ]);
  });

  it("EUA: documento sem tipo, tipo desconhecido (SSN) e número fora da régua vão para os erros", async () => {
    montar();
    const { corpo } = await importarCsv("nome,telefone,documento,tipo_de_documento", [
      "Ana,+14075551234,A12345678,",
      "Bia,+14075551235,123-45-6789,SSN",
      "Caio,+14075551236,812-70-1234,ITIN",
      "Duda,+14075551237,,",
    ]);
    expect(corpo.data.imported).toBe(1);
    expect(corpo.data.errors.map((e) => e.linha)).toEqual([2, 3, 4]);
    expect(contatos()).toHaveLength(1);
    expect(contatos()[0]).not.toHaveProperty("cpf_hash");
  });

  it("EUA: SSN com hífens numa linha de carteira de motorista é recusado antes de normalizar", async () => {
    montar();
    const { corpo } = await importarCsv("name,phone_number,document,document_type", [
      "Eva,+14075551238,123-45-6789,Driver's License",
    ]);
    expect(corpo.data.imported).toBe(0);
    expect(corpo.data.errors).toEqual([expect.objectContaining({ linha: 2, motivo: expect.stringContaining(MENSAGEM_SSN) })]);
    expect(contatos()).toHaveLength(0);
  });

  it("EUA: telefone sem DDI vira +1 (e não +55); com + é respeitado", async () => {
    montar();
    const { corpo } = await importarCsv("name,phone_number", ["Ana,(407) 555-1234", "Bia,14075551235", "Caio,+55 11 99999-8888"]);
    expect(corpo.data).toMatchObject({ imported: 3, errors: [] });
    expect(contatos().map((c) => c.phone_number)).toEqual(["+14075551234", "+14075551235", "+5511999998888"]);
  });

  it("Brasil: telefone sem DDI continua +55", async () => {
    orgDaSessao = ORG_BR;
    montar();
    const { corpo } = await importarCsv("nome,telefone", ["Ana,(11) 99999-8888"]);
    expect(corpo.data).toMatchObject({ imported: 1, errors: [] });
    expect(contatos()[0]).toMatchObject({ phone_number: "+5511999998888" });
  });

  it("Brasil: a coluna de tipo não é reconhecida e o CPF importa como sempre", async () => {
    orgDaSessao = ORG_BR;
    montar();
    const { corpo } = await importarCsv("nome,telefone,cpf,tipo_de_documento", ["Ana,+5511999998888,529.982.247-25,us_passport"]);
    expect(corpo.data).toMatchObject({ imported: 1, errors: [] });
    expect(contatos()[0]).toMatchObject({ cpf_hash: hashCpf(CPF), document_type: null });
  });
});
