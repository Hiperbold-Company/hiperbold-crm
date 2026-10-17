/**
 * D-216, lado do código: o cliente com a sessão do usuário nunca nomeia `cpf_hash` nem `cpf_encrypted`.
 *
 * A migration 0967 tira SELECT/INSERT/UPDATE dessas duas colunas de `authenticated`/`anon`; qualquer consulta do
 * usuário que as nomeie (ou use `select *`) passaria a dar "permission denied". Estes casos rodam o handler real de
 * contatos com um cliente de usuário de mentira que REGISTRA o que lhe é pedido, e um servidor (cliente de serviço) de
 * mentira que guarda os CPFs. O banco de verdade é medido por `tests/invariants/contacts-cpf-so-do-servidor.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiError } from "@/lib/api/types";

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const OUTRO = "c05e7a00-0000-4000-8000-0000000000c2";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const CPF = "52998224725";

/** O que o servidor (cliente de serviço) tem: quem tem CPF, e quem é dono de qual hash. */
const servidor = {
  comCpf: new Set<string>(),
  donos: new Map<string, string[]>(),
  gravacoes: [] as Array<{ org: string; id: string; hash: string; cifrado: unknown }>,
  erroAoGravar: null as { code: string | null; message: string } | null,
  decifrados: [] as string[],
  cpfEmClaro: "52998224725" as string | null,
};
const logs: Array<{ nivel: string; mensagem: string; dados: unknown }> = [];
let erroAoApagar: { code?: string; message: string } | null = null;
let papelDoUsuario = "manager";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: (mensagem: string, dados?: unknown) => logs.push({ nivel: "info", mensagem, dados }),
    warn: (mensagem: string, dados?: unknown) => logs.push({ nivel: "warn", mensagem, dados }),
    error: (mensagem: string, dados?: unknown) => logs.push({ nivel: "error", mensagem, dados }),
    debug: () => undefined,
  },
}));
vi.mock("@/lib/contacts/cpf-do-contato", () => ({
  CPF_SEM_LINHA: "cpf_contato_nao_gravavel",
  decifrarCpfDoContato: vi.fn(async (_org: string, id: string) => {
    servidor.decifrados.push(id);
    return servidor.cpfEmClaro;
  }),
  cifrarCpfDoContato: vi.fn(async (cpf: string) => `cifrado(${cpf})`),
  idsComCpf: vi.fn(async (_org: string, ids: string[]) => ({
    ids: new Set(ids.filter((i) => servidor.comCpf.has(i))),
    error: null,
  })),
  idsPorHashDeCpf: vi.fn(async (_org: string, hash: string) => ({ ids: servidor.donos.get(hash) ?? [], error: null })),
  gravarCpfDoContatoPorUsuario: vi.fn(
    async (org: string, id: string, cpf: { hash: string; cifrado: unknown }) => {
      if (servidor.erroAoGravar) return servidor.erroAoGravar;
      servidor.gravacoes.push({ org, id, hash: cpf.hash, cifrado: cpf.cifrado });
      servidor.comCpf.add(id);
      return null;
    },
  ),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ error: null }) }) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: vi.fn(),
  sessaoProntaParaEnvio: vi.fn(async () => null),
}));

import {
  createContactHandler,
  getContactHandler,
  listContactsHandler,
  patchContactHandler,
} from "@/app/api/v1/contacts/_handler";

process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-cpf";
import { hashCpf } from "@/lib/contacts/cpf";

const ctx = { organization_id: ORG, actor: { type: "user" as const, id: "u-1" }, requestId: "req" };

/** Tudo o que o cliente do USUÁRIO recebeu: colunas pedidas, filtros, linhas inseridas/atualizadas, deletes. */
const usuario = {
  selects: [] as string[],
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  deletes: [] as string[],
  orFiltros: [] as string[],
  linhas: [] as Array<Record<string, unknown>>,
};

function clienteDoUsuario(): never {
  let modo: "select" | "insert" | "update" | "delete" = "select";
  let filtroId: string | null = null;
  let tabela = "contacts";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cadeia: any = {
    select: (cols?: string) => {
      if (tabela === "user_organizations") return cadeia;
      usuario.selects.push(cols ?? "*");
      return cadeia;
    },
    insert: (linha: Record<string, unknown>) => {
      modo = "insert";
      usuario.inserts.push(linha);
      return cadeia;
    },
    update: (patch: Record<string, unknown>) => {
      modo = "update";
      usuario.updates.push(patch);
      return cadeia;
    },
    delete: () => {
      modo = "delete";
      return cadeia;
    },
    eq: (coluna: string, valor: string) => {
      if (coluna === "id") filtroId = valor;
      return cadeia;
    },
    or: (expr: string) => {
      usuario.orFiltros.push(expr);
      return cadeia;
    },
    is: () => cadeia,
    in: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    contains: () => cadeia,
    gt: () => cadeia,
    lt: () => cadeia,
    single: async () => ({ data: usuario.linhas.at(-1) ?? null, error: null }),
    maybeSingle: async () => ({
      data: tabela === "user_organizations" ? { role: papelDoUsuario } : usuario.linhas.find((l) => l.id === filtroId) ?? usuario.linhas[0] ?? null,
      error: null,
    }),
    then: (res: (v: unknown) => unknown) => {
      if (modo === "delete" && filtroId) usuario.deletes.push(filtroId);
      return Promise.resolve({
        data: modo === "select" ? usuario.linhas : null,
        error: modo === "delete" ? erroAoApagar : null,
      }).then(res);
    },
  };
  return { from: (t: string) => ((tabela = t), cadeia), rpc: async () => ({ error: null }) } as never;
}

const linha = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG,
  name: "Maria",
  display_name: null,
  email: null,
  phone_number: null,
  tags: [],
  consent: {},
  custom_fields: {},
  is_anonymized: false,
  ...extra,
});

/** Nenhuma coluna do CPF, nem `*`, foi pedida ao banco pelo cliente do usuário. */
const pedidosAoBancoDoUsuario = () => usuario.selects.join(" | ");

beforeEach(() => {
  servidor.comCpf = new Set();
  servidor.donos = new Map();
  servidor.gravacoes = [];
  servidor.erroAoGravar = null;
  usuario.selects = [];
  usuario.inserts = [];
  usuario.updates = [];
  usuario.deletes = [];
  usuario.orFiltros = [];
  usuario.linhas = [];
  servidor.decifrados = [];
  servidor.cpfEmClaro = CPF;
  logs.length = 0;
  erroAoApagar = null;
  papelDoUsuario = "manager";
});

describe("lista e leitura de contatos pela sessão do usuário", () => {
  it("a lista não pede cpf_hash nem `*` ao banco e ainda diz quem tem CPF", async () => {
    usuario.linhas = [linha(CONTATO), linha(OUTRO)];
    servidor.comCpf.add(CONTATO);

    const r = await listContactsHandler(
      clienteDoUsuario(),
      ctx,
      { order_by: "created_at", order_dir: "desc", limit: 25 },
    );

    expect(pedidosAoBancoDoUsuario()).not.toMatch(/cpf_|\*/);
    expect(r.contacts.map((c) => [c.id, c.cpf_available])).toEqual([
      [CONTATO, true],
      [OUTRO, false],
    ]);
    expect(JSON.stringify(r)).not.toContain("cpf_hash");
  });

  it("buscar por CPF acha o contato pelo servidor e filtra por id, sem nomear cpf_hash na consulta do usuário", async () => {
    const hash = hashCpf(CPF) as string;
    servidor.donos.set(hash, [CONTATO]);
    usuario.linhas = [linha(CONTATO)];

    await listContactsHandler(
      clienteDoUsuario(),
      ctx,
      { order_by: "created_at", order_dir: "desc", limit: 25, search: CPF },
    );

    expect(usuario.orFiltros.join(" ")).toContain(`id.eq.${CONTATO}`);
    expect(usuario.orFiltros.join(" ")).not.toContain("cpf_hash");
  });

  it("o get devolve cpf_available vindo do servidor e não pede a coluna do CPF", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);

    const r = await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO });

    expect(r.cpf_available).toBe(true);
    expect(pedidosAoBancoDoUsuario()).not.toMatch(/cpf_|\*/);
    expect(JSON.stringify(r)).not.toContain("cpf_hash");
  });
});

describe("criar contato com CPF", () => {
  it("o INSERT do usuário não leva o CPF; o servidor o grava no contato criado", async () => {
    usuario.linhas = [linha(CONTATO)];

    const r = await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", cpf: CPF, source: "manual" } as never);

    expect(usuario.inserts[0]).not.toHaveProperty("cpf_hash");
    expect(usuario.inserts[0]).not.toHaveProperty("cpf_encrypted");
    expect(pedidosAoBancoDoUsuario()).not.toMatch(/cpf_|\*/);
    expect(servidor.gravacoes).toEqual([{ org: ORG, id: CONTATO, hash: hashCpf(CPF), cifrado: `cifrado(${CPF})` }]);
    expect(r.contact.cpf_available).toBe(true);
  });

  it("CPF que já é de outro contato é recusado ANTES do INSERT: nada é criado nem apagado", async () => {
    servidor.donos.set(hashCpf(CPF) as string, [OUTRO]);

    const erro = await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(
      (e: unknown) => e,
    );

    expect((erro as ApiError).status).toBe(500);
    expect(usuario.inserts).toHaveLength(0);
    expect(usuario.deletes).toHaveLength(0);
  });

  it("corrida: se a gravação falha depois do INSERT, o contato é desfeito (rede de segurança)", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.erroAoGravar = { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_cpf"' };

    const erro = await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(
      (e: unknown) => e,
    );

    expect((erro as ApiError).status).toBe(500);
    expect(usuario.deletes).toEqual([CONTATO]);
  });

  it("se nem o desfazer funciona, o erro do apagamento é registrado no log", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.erroAoGravar = { code: "23505", message: "duplicate" };
    erroAoApagar = { code: "42501", message: "permission denied" };

    await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(() => undefined);

    const registro = logs.find((l) => l.nivel === "error");
    expect(registro?.mensagem).toMatch(/desfazer o contato criado/);
    expect(registro?.dados).toMatchObject({ contactId: CONTATO, organizationId: ORG, errorCode: "42501" });
  });

  it("contato anonimizado (ou sumido) no momento de gravar o CPF: 409, e o contato novo é desfeito", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.erroAoGravar = { code: "cpf_contato_nao_gravavel", message: "contato anonimizado" };

    const erro = await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", cpf: CPF, source: "manual" } as never).catch(
      (e: unknown) => e,
    );

    expect((erro as ApiError).status).toBe(409);
    expect(usuario.deletes).toEqual([CONTATO]);
  });

  it("sem CPF no corpo, o servidor não é chamado", async () => {
    usuario.linhas = [linha(CONTATO)];
    const r = await createContactHandler(clienteDoUsuario(), ctx, { name: "Maria", source: "manual" } as never);
    expect(servidor.gravacoes).toHaveLength(0);
    expect(r.contact.cpf_available).toBe(false);
  });
});

describe("alterar o CPF de um contato", () => {
  it("PATCH só do CPF: o UPDATE do usuário leva só updated_at, e o servidor grava o par", async () => {
    usuario.linhas = [linha(CONTATO)];

    const r = await patchContactHandler(clienteDoUsuario(), ctx, CONTATO, { cpf: CPF } as never);

    expect(Object.keys(usuario.updates[0] ?? {})).toEqual(["updated_at"]);
    expect(servidor.gravacoes).toHaveLength(1);
    expect(r.cpf_available).toBe(true);
  });

  it("CPF que já é de OUTRO contato da organização: recusa antes de alterar qualquer campo", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.donos.set(hashCpf(CPF) as string, [OUTRO]);

    const erro = await patchContactHandler(clienteDoUsuario(), ctx, CONTATO, { name: "Novo", cpf: CPF } as never).catch(
      (e: unknown) => e,
    );

    expect((erro as ApiError).status).toBe(500);
    expect(usuario.updates).toHaveLength(0);
    expect(servidor.gravacoes).toHaveLength(0);
  });

  it("PATCH sem CPF não aciona gravação do servidor e preserva cpf_available do contato", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);

    const r = await patchContactHandler(clienteDoUsuario(), ctx, CONTATO, { name: "Maria Silva" } as never);

    expect(servidor.gravacoes).toHaveLength(0);
    expect(r.cpf_available).toBe(true);
    expect(usuario.updates[0]).not.toHaveProperty("cpf_hash");
  });
});

describe("PATCH do CPF e contato anonimizado no meio do caminho", () => {
  it("a gravação não alterou linha (anonimizado depois da leitura): 409, nunca 'gravado'", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.erroAoGravar = { code: "cpf_contato_nao_gravavel", message: "contato anonimizado" };

    const erro = await patchContactHandler(clienteDoUsuario(), ctx, CONTATO, { cpf: CPF } as never).catch((e: unknown) => e);

    expect((erro as ApiError).status).toBe(409);
  });
});

describe("abrir o CPF do contato (decrypt_cpf não existe: decifra o servidor)", () => {
  it("manager com propósito informado recebe o CPF, decifrado pelo servidor", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);

    const r = await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO, decryptPurpose: "atendimento" });

    expect(r.cpf_decrypted).toBe(CPF);
    expect(servidor.decifrados).toEqual([CONTATO]);
  });

  it("agent (abaixo de manager) é negado e o servidor nem é chamado", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);
    papelDoUsuario = "agent";

    const r = await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO, decryptPurpose: "atendimento" });

    expect(r.cpf_decrypted).toBeNull();
    expect(r.cpf_decrypt_denied).toBe(true);
    expect(servidor.decifrados).toHaveLength(0);
  });

  it("sem propósito informado, ou sem CPF no contato, o servidor não decifra", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);
    await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO });
    servidor.comCpf.clear();
    await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO, decryptPurpose: "x" });
    expect(servidor.decifrados).toHaveLength(0);
  });

  it("se o banco não consegue decifrar, a resposta segue sem CPF (e registra aviso)", async () => {
    usuario.linhas = [linha(CONTATO)];
    servidor.comCpf.add(CONTATO);
    servidor.cpfEmClaro = null;

    const r = await getContactHandler(clienteDoUsuario(), ctx, { contactId: CONTATO, decryptPurpose: "atendimento" });

    expect(r.cpf_decrypted).toBeNull();
    expect(logs.some((l) => l.nivel === "warn" && /decifrar o CPF/.test(l.mensagem))).toBe(true);
  });
});
