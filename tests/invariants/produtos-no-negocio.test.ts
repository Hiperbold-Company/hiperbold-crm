import { execFileSync, spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PRODUTOS NO NEGÓCIO (migration 0972) — provado no Postgres real.
 *
 * Três promessas, e cada uma tem um caso que a quebra se alguém a afrouxar:
 *
 *  1. O VALOR DO NEGÓCIO É A SOMA DOS ITENS, e é o BANCO que a mantém: inserir,
 *     alterar e apagar item refaz o total, e um `update crm_leads set value_cents`
 *     por fora (formulário, importação, automação) não consegue desfazê-la.
 *     Negócio sem itens continua com o valor digitado.
 *  2. A TABELA É TENANT-AWARE com a visibilidade do negócio-pai: outra organização
 *     não lê nem escreve; atendente que não enxerga o negócio não enxerga os
 *     itens; `viewer` lê e não escreve.
 *  3. PREÇO FIXO OU VARIÁVEL: variável pode ficar sem preço, fixo não.
 *
 * Rodar como `postgres` mediria nada (BYPASSRLS): as provas de RLS usam
 * `set role authenticated` + `request.jwt.claims`, o caminho da produção.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

const ultima = (out: string) => out.split("\n").pop() ?? "";

/** Como superusuário: o que ESTÁ na tabela, independente de quem consegue ler. */
const noBanco = (script: string) => ultima(sql(`reset role;\n${script}`));

/** Como a sessão de um usuário (RLS vale). Erro de SQL vira exceção. */
function como(userId: string, script: string): string {
  return ultima(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${script}
    `),
  );
}

const ORG_A = "eeeeeeee-0000-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-0000-4000-8000-00000000000b";
const MGR_A = "eeeeeeee-1111-4000-8000-00000000000a";
const AGENT_1 = "eeeeeeee-1111-4000-8000-00000000000c";
const AGENT_2 = "eeeeeeee-1111-4000-8000-00000000000d";
const VIEWER_A = "eeeeeeee-1111-4000-8000-00000000000e";
const MGR_B = "eeeeeeee-1111-4000-8000-00000000000b";
const PIPE_A = "eeeeeeee-2222-4000-8000-00000000000a";
const STAGE_A = "eeeeeeee-3333-4000-8000-00000000000a";
const PIPE_B = "eeeeeeee-2222-4000-8000-00000000000b";
const STAGE_B = "eeeeeeee-3333-4000-8000-00000000000b";
/** Negócio do AGENT_1: o AGENT_2 não o enxerga (visibilidade padrão own_and_unassigned). */
const LEAD_DO_1 = "eeeeeeee-4444-4000-8000-000000000001";
/** Negócio sem itens, valor digitado. */
const LEAD_MANUAL = "eeeeeeee-4444-4000-8000-000000000002";
const LEAD_B = "eeeeeeee-4444-4000-8000-00000000000b";
const P_FIXO = "eeeeeeee-5555-4000-8000-000000000001";
const P_VARIAVEL = "eeeeeeee-5555-4000-8000-000000000002";
const P_B = "eeeeeeee-5555-4000-8000-00000000000b";

const valorDo = (lead: string) => noBanco(`select coalesce(value_cents::text, 'null') from public.crm_leads where id = '${lead}';`);
const itensDe = (lead: string) => Number(noBanco(`select count(*) from public.crm_lead_itens where lead_id = '${lead}';`));

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MGR_A}', 'pn-mgr-a@invariant.test'), ('${AGENT_1}', 'pn-agent-1@invariant.test'),
      ('${AGENT_2}', 'pn-agent-2@invariant.test'), ('${VIEWER_A}', 'pn-viewer-a@invariant.test'),
      ('${MGR_B}', 'pn-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'pn-inv-a', 'PN A', 'PN A'), ('${ORG_B}', 'pn-inv-b', 'PN B', 'PN B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MGR_A}', '${ORG_A}', 'manager', now()), ('${AGENT_1}', '${ORG_A}', 'agent', now()),
      ('${AGENT_2}', '${ORG_A}', 'agent', now()), ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${MGR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A}', '${ORG_A}', 'PN A', 'pn-a'), ('${PIPE_B}', '${ORG_B}', 'PN B', 'pn-b')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1000),
      ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, value_cents) values
      ('${LEAD_DO_1}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'PN lead do agente 1', '${AGENT_1}', null),
      ('${LEAD_MANUAL}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'PN lead manual', null, 7700),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${STAGE_B}', 'PN lead B', null, null)
      on conflict do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, tipo_de_preco, preco_cents) values
      ('${P_FIXO}', '${ORG_A}', 'PN-FIXO', 'Consulta', 'fixo', 15000),
      ('${P_VARIAVEL}', '${ORG_A}', 'PN-VAR', 'Projeto sob medida', 'variavel', null),
      ('${P_B}', '${ORG_B}', 'PN-B', 'Do vizinho', 'fixo', 999)
      on conflict do nothing;
  `);
});

describe("catalog_products — preço fixo ou variável", () => {
  it("produto de valor variável vive sem preço", () => {
    expect(noBanco(`select preco_cents is null from public.catalog_products where id = '${P_VARIAVEL}';`)).toBe("t");
  });

  it("produto de valor fixo sem preço é recusado pelo banco", () => {
    expect(() =>
      sql(`insert into public.catalog_products (organization_id, codigo, nome, tipo_de_preco, preco_cents)
           values ('${ORG_A}', 'PN-FIXO-SEM', 'Fixo sem preço', 'fixo', null);`),
    ).toThrow(/catalog_products_fixo_tem_preco/);
  });

  it("tipo fora do vocabulário é recusado", () => {
    expect(() =>
      sql(`insert into public.catalog_products (organization_id, codigo, nome, tipo_de_preco, preco_cents)
           values ('${ORG_A}', 'PN-TIPO', 'Tipo ruim', 'gratis', 1);`),
    ).toThrow(/catalog_products_tipo_de_preco_valido/);
  });

  it("linha criada sem informar o tipo é de valor fixo (o que já existia não muda de natureza)", () => {
    sql(`insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
         values ('${ORG_A}', 'PN-DEFAULT', 'Sem tipo', 100) on conflict do nothing;`);
    expect(
      noBanco(`select tipo_de_preco from public.catalog_products where organization_id = '${ORG_A}' and codigo = 'PN-DEFAULT';`),
    ).toBe("fixo");
  });
});

describe("o valor do negócio é a soma dos itens (gatilho)", () => {
  it("inserir, alterar e apagar item refaz o total; apagar o último NÃO zera o valor", () => {
    expect(itensDe(LEAD_DO_1)).toBe(0);

    // O agente 1 (dono do negócio) adiciona: 2 × R$ 150,00 + 1 × R$ 4.800,00.
    como(AGENT_1, `insert into public.crm_lead_itens (organization_id, lead_id, product_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('${ORG_A}', '${LEAD_DO_1}', '${P_FIXO}', 'Consulta', 2, 15000);`);
    expect(valorDo(LEAD_DO_1)).toBe("30000");
    como(AGENT_1, `insert into public.crm_lead_itens (organization_id, lead_id, product_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('${ORG_A}', '${LEAD_DO_1}', '${P_VARIAVEL}', 'Projeto sob medida', 1, 480000);`);
    expect(valorDo(LEAD_DO_1)).toBe("510000");

    como(AGENT_1, `update public.crm_lead_itens set quantidade = 3 where lead_id = '${LEAD_DO_1}' and nome_snapshot = 'Consulta';`);
    expect(valorDo(LEAD_DO_1)).toBe("525000");

    como(AGENT_1, `delete from public.crm_lead_itens where lead_id = '${LEAD_DO_1}' and nome_snapshot = 'Consulta';`);
    expect(valorDo(LEAD_DO_1)).toBe("480000");

    como(AGENT_1, `delete from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`);
    expect(itensDe(LEAD_DO_1)).toBe(0);
    // Sem itens o valor volta a ser do usuário e fica com o último total (não vira nulo nem zero).
    expect(valorDo(LEAD_DO_1)).toBe("480000");
  });

  it("com itens, um valor digitado por fora (formulário, importação, automação) não desfaz a soma", () => {
    como(AGENT_1, `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('${ORG_A}', '${LEAD_DO_1}', 'Avulso', 1, 20000);`);
    expect(valorDo(LEAD_DO_1)).toBe("20000");

    como(AGENT_1, `update public.crm_leads set value_cents = 1 where id = '${LEAD_DO_1}';`);
    expect(valorDo(LEAD_DO_1)).toBe("20000");
    // Também pelo caminho de superusuário (service role/importação).
    noBanco(`update public.crm_leads set value_cents = 99 where id = '${LEAD_DO_1}';`);
    expect(valorDo(LEAD_DO_1)).toBe("20000");

    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`);
  });

  it("negócio SEM itens continua com o valor digitado à mão", () => {
    como(AGENT_1, `update public.crm_leads set value_cents = 12345 where id = '${LEAD_MANUAL}' and owner_user_id is null;`);
    expect(valorDo(LEAD_MANUAL)).toBe("12345");
    expect(itensDe(LEAD_MANUAL)).toBe(0);
  });

  it("arredonda por linha: 1,5 × R$ 3,33 = 500 centavos, duas linhas somam 1000", () => {
    noBanco(`insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents) values
      ('${ORG_A}', '${LEAD_MANUAL}', 'A', 1.5, 333), ('${ORG_A}', '${LEAD_MANUAL}', 'B', 1.5, 333);`);
    expect(valorDo(LEAD_MANUAL)).toBe("1000");
    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_MANUAL}';`);
  });

  it("quantidade zero/negativa e valor negativo são recusados", () => {
    for (const [q, v] of [[0, 100], [-1, 100], [1, -5]]) {
      expect(() =>
        sql(`insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
             values ('${ORG_A}', '${LEAD_MANUAL}', 'Ruim', ${q}, ${v});`),
      ).toThrow();
    }
  });
});

describe("crm_lead_itens — isolamento e visibilidade do negócio-pai", () => {
  beforeAll(() => {
    noBanco(`insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents) values
      ('${ORG_A}', '${LEAD_DO_1}', 'Item do negócio do agente 1', 1, 1000),
      ('${ORG_B}', '${LEAD_B}', 'Item da org B', 1, 2000);`);
  });

  const veTudo = (u: string, lead: string) =>
    Number(como(u, `select count(*) from public.crm_lead_itens where lead_id = '${lead}';`));

  it("o dono do negócio e o manager veem os itens; o viewer também lê", () => {
    expect(veTudo(AGENT_1, LEAD_DO_1)).toBe(1);
    expect(veTudo(MGR_A, LEAD_DO_1)).toBe(1);
    expect(veTudo(VIEWER_A, LEAD_DO_1)).toBe(1);
  });

  it("o atendente que NÃO enxerga o negócio não enxerga os itens dele", () => {
    expect(veTudo(AGENT_2, LEAD_DO_1)).toBe(0);
  });

  it("outra organização não lê nada, nem pelo id do negócio", () => {
    expect(veTudo(MGR_B, LEAD_DO_1)).toBe(0);
    expect(Number(como(MGR_B, `select count(*) from public.crm_lead_itens where organization_id = '${ORG_A}';`))).toBe(0);
    expect(veTudo(MGR_A, LEAD_B)).toBe(0);
  });

  it("o atendente que não enxerga o negócio não escreve nele", () => {
    expect(() =>
      como(AGENT_2, `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_A}', '${LEAD_DO_1}', 'Intruso', 1, 1);`),
    ).toThrow(/row-level security/);
  });

  it("o viewer lê e não escreve", () => {
    expect(() =>
      como(VIEWER_A, `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_A}', '${LEAD_DO_1}', 'Do viewer', 1, 1);`),
    ).toThrow(/row-level security/);
  });

  it("outra organização não escreve, nem declarando a organização do negócio", () => {
    expect(() =>
      como(MGR_B, `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_A}', '${LEAD_DO_1}', 'Invasor A', 1, 1);`),
    ).toThrow(/row-level security/);
    expect(() =>
      como(MGR_B, `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_B}', '${LEAD_DO_1}', 'Invasor B', 1, 1);`),
    ).toThrow();
  });

  it("outra organização não altera nem apaga item alheio", () => {
    const antes = noBanco(`select count(*) from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`);
    como(MGR_B, `delete from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`);
    como(MGR_B, `update public.crm_lead_itens set valor_unitario_cents = 1 where lead_id = '${LEAD_DO_1}';`);
    expect(noBanco(`select count(*) from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`)).toBe(antes);
    expect(noBanco(`select min(valor_unitario_cents) from public.crm_lead_itens where lead_id = '${LEAD_DO_1}';`)).toBe("1000");
  });

  it("gatilho de vínculo: item com a organização trocada, ou com produto de outra, é recusado até para o superusuário", () => {
    expect(() =>
      sql(`insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_B}', '${LEAD_DO_1}', 'Org trocada', 1, 1);`),
    ).toThrow(/Registro vinculado/);
    expect(() =>
      sql(`insert into public.crm_lead_itens (organization_id, lead_id, product_id, nome_snapshot, quantidade, valor_unitario_cents)
        values ('${ORG_A}', '${LEAD_DO_1}', '${P_B}', 'Produto do vizinho', 1, 1);`),
    ).toThrow(/Registro vinculado/);
  });

  it("anon não tem privilégio na tabela, e as funções de gatilho não são chamáveis por ninguém de fora", () => {
    expect(noBanco(`select has_table_privilege('anon', 'public.crm_lead_itens', 'select');`)).toBe("f");
    for (const f of [
      "fn_crm_lead_itens_vinculos_da_organizacao",
      "fn_crm_lead_itens_recalcula_valor",
      "fn_crm_leads_valor_pelos_itens",
    ]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(noBanco(`select has_function_privilege('${papel}', 'public.${f}()', 'execute');`)).toBe("f");
      }
      expect(noBanco(`select has_function_privilege('public', 'public.${f}()', 'execute');`)).toBe("f");
    }
  });
});

describe("histórico do negócio sobrevive ao catálogo e ao negócio", () => {
  it("apagar o produto do catálogo mantém o item, com o nome copiado e o valor do negócio", () => {
    const antes = valorDo(LEAD_MANUAL);
    noBanco(`insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents)
      values ('eeeeeeee-5555-4000-8000-0000000000f1', '${ORG_A}', 'PN-APAGAR', 'Vai sair', 500);
      insert into public.crm_lead_itens (id, organization_id, lead_id, product_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('eeeeeeee-6666-4000-8000-0000000000f1', '${ORG_A}', '${LEAD_MANUAL}', 'eeeeeeee-5555-4000-8000-0000000000f1', 'Vai sair', 1, 500);`);
    noBanco(`delete from public.catalog_products where id = 'eeeeeeee-5555-4000-8000-0000000000f1';`);

    expect(noBanco(`select product_id is null from public.crm_lead_itens where id = 'eeeeeeee-6666-4000-8000-0000000000f1';`)).toBe("t");
    expect(noBanco(`select nome_snapshot from public.crm_lead_itens where id = 'eeeeeeee-6666-4000-8000-0000000000f1';`)).toBe("Vai sair");
    expect(valorDo(LEAD_MANUAL)).toBe("500");
    expect(antes).not.toBe("");
    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_MANUAL}';`);
  });

  it("apagar o negócio apaga os itens dele", () => {
    noBanco(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('eeeeeeee-4444-4000-8000-0000000000f2', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'PN efêmero');
      insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('${ORG_A}', 'eeeeeeee-4444-4000-8000-0000000000f2', 'X', 1, 1);`);
    noBanco(`delete from public.crm_leads where id = 'eeeeeeee-4444-4000-8000-0000000000f2';`);
    expect(itensDe("eeeeeeee-4444-4000-8000-0000000000f2")).toBe(0);
  });
});

// ─── Auditoria de 20/10/2026 ─────────────────────────────────────────────────

const PA_FULL = "eeeeeeee-1111-4000-8000-0000000000f1";
const PA_SUPORTE = "eeeeeeee-1111-4000-8000-0000000000f2";
const LEAD_TETO = "eeeeeeee-4444-4000-8000-0000000000a1";
const LEAD_100 = "eeeeeeee-4444-4000-8000-0000000000a2";

const insereItem = (lead: string, nome: string, q: number | string, v: number | string) =>
  `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
   values ('${ORG_A}', '${lead}', ${nome}, ${q}, ${v});`;

describe("a escrita do admin de plataforma é só a do escopo COMPLETO", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${PA_FULL}', 'pn-pa-full@invariant.test'), ('${PA_SUPORTE}', 'pn-pa-suporte@invariant.test')
        on conflict (id) do nothing;
      insert into public.platform_admins (user_id, granted_by, scope, reason) values
        ('${PA_FULL}', '${PA_FULL}', 'full', 'invariante 0972'),
        ('${PA_SUPORTE}', '${PA_FULL}', 'support_readonly', 'invariante 0972')
        on conflict (user_id) do nothing;
    `);
    noBanco(`insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
      values ('${ORG_A}', '${LEAD_MANUAL}', 'Item do suporte', 1, 5000);`);
  });

  it("o suporte somente-leitura LÊ os itens, mas não insere, não altera e não apaga", () => {
    expect(Number(como(PA_SUPORTE, `select count(*) from public.crm_lead_itens where lead_id = '${LEAD_MANUAL}';`))).toBeGreaterThan(0);
    expect(() => como(PA_SUPORTE, insereItem(LEAD_MANUAL, "'Do suporte'", 1, 1))).toThrow(/row-level security/);
    como(PA_SUPORTE, `update public.crm_lead_itens set valor_unitario_cents = 1 where lead_id = '${LEAD_MANUAL}';`);
    como(PA_SUPORTE, `delete from public.crm_lead_itens where lead_id = '${LEAD_MANUAL}';`);
    expect(noBanco(`select valor_unitario_cents from public.crm_lead_itens where nome_snapshot = 'Item do suporte';`)).toBe("5000");
  });

  it("o admin de plataforma COMPLETO escreve", () => {
    como(PA_FULL, insereItem(LEAD_MANUAL, "'Do admin completo'", 1, 100));
    expect(noBanco(`select count(*) from public.crm_lead_itens where nome_snapshot = 'Do admin completo';`)).toBe("1");
    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_MANUAL}';`);
  });
});

describe("tetos: subtotal seguro para o JavaScript e nome curto", () => {
  beforeAll(() => {
    noBanco(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${LEAD_TETO}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'PN teto') on conflict do nothing;`);
  });

  it("subtotal de 9e13 centavos passa; um centavo acima é recusado pelo CHECK", () => {
    sql(insereItem(LEAD_TETO, "'No teto'", 900, 100000000000));
    expect(() => sql(insereItem(LEAD_TETO, "'Acima do teto'", 901, 100000000000))).toThrow(/crm_lead_itens_subtotal_teto/);
    // Os dois campos isolados continuam nos próprios tetos.
    expect(() => sql(insereItem(LEAD_TETO, "'Qtd absurda'", 1000001, 1))).toThrow();
    expect(() => sql(insereItem(LEAD_TETO, "'Valor absurdo'", 1, 100000000001))).toThrow();
    // Alterar um campo de um item existente também respeita o teto.
    expect(() =>
      sql(`update public.crm_lead_itens set quantidade = 5000 where lead_id = '${LEAD_TETO}' and nome_snapshot = 'No teto';`),
    ).toThrow(/crm_lead_itens_subtotal_teto/);
  });

  it("100 itens no teto somam menos que o inteiro seguro do JavaScript", () => {
    // 100 × 9e13 = 9e15 < 9.007e15 (o negócio de 100 itens, no máximo, nunca passa disso).
    expect(noBanco(`select (100 * 90000000000000::bigint) < 9007199254740991;`)).toBe("t");
  });

  it("nome com 300 caracteres passa e com 301 é recusado", () => {
    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_TETO}';`);
    sql(insereItem(LEAD_TETO, "repeat('a', 300)", 1, 1));
    expect(() => sql(insereItem(LEAD_TETO, "repeat('a', 301)", 1, 1))).toThrow(/crm_lead_itens_nome_curto/);
  });
});

describe("no máximo 100 itens por negócio, no banco", () => {
  beforeAll(() => {
    noBanco(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${LEAD_100}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'PN cem itens') on conflict do nothing;
      insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
      select '${ORG_A}', '${LEAD_100}', 'item ' || g, 1, 1 from generate_series(1, 98) g;`);
  });

  it("o 99º e o 100º entram; o 101º é recusado, também pela sessão do usuário (REST)", () => {
    sql(insereItem(LEAD_100, "'item 99'", 1, 1));
    sql(insereItem(LEAD_100, "'item 100'", 1, 1));
    expect(itensDe(LEAD_100)).toBe(100);
    expect(() => sql(insereItem(LEAD_100, "'item 101'", 1, 1))).toThrow(/máximo de produtos/);
    expect(() => como(MGR_A, insereItem(LEAD_100, "'item 101 pelo gerente'", 1, 1))).toThrow(/máximo de produtos/);
    expect(itensDe(LEAD_100)).toBe(100);
  });

  it("sem corrida: duas inserções simultâneas com 99 itens deixam exatamente 100", async () => {
    noBanco(`delete from public.crm_lead_itens where lead_id = '${LEAD_100}' and nome_snapshot in ('item 100', 'item 99');`);
    sql(insereItem(LEAD_100, "'item 99'", 1, 1));
    expect(itensDe(LEAD_100)).toBe(99);

    const rodar = (nome: string) =>
      new Promise<boolean>((resolve) => {
        const p = spawn(
          "docker",
          ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
          { stdio: ["pipe", "ignore", "ignore"] },
        );
        p.on("close", (codigo) => resolve(codigo === 0));
        p.stdin.end(insereItem(LEAD_100, `'${nome}'`, 1, 1));
      });
    const resultados = await Promise.all([rodar("corrida A"), rodar("corrida B")]);

    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(itensDe(LEAD_100)).toBe(100);
  });
});

describe("privilégios de tabela de crm_lead_itens", () => {
  it("authenticated não tem TRUNCATE, REFERENCES nem TRIGGER (TRUNCATE ignora RLS) e mantém o CRUD; anon não tem nada", () => {
    for (const priv of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(noBanco(`select has_table_privilege('authenticated', 'public.crm_lead_itens', '${priv}');`)).toBe("f");
    }
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(noBanco(`select has_table_privilege('authenticated', 'public.crm_lead_itens', '${priv}');`)).toBe("t");
      expect(noBanco(`select has_table_privilege('anon', 'public.crm_lead_itens', '${priv}');`)).toBe("f");
    }
    expect(() => como(MGR_A, `truncate public.crm_lead_itens;`)).toThrow(/permission denied/);
  });

  it("a função do limite também não é chamável por ninguém de fora", () => {
    for (const papel of ["anon", "authenticated", "public"]) {
      expect(noBanco(`select has_function_privilege('${papel}', 'public.fn_crm_lead_itens_limite_por_negocio()', 'execute');`)).toBe("f");
    }
  });
});
