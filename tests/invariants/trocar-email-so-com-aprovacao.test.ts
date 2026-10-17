/**
 * Migração 0966 (D-204): o e-mail de uma conta só muda com aprovação do servidor. Provado no Postgres real:
 *
 *   1. a tabela de aprovações tem RLS ligada, nenhuma policy e nenhum privilégio para anon/authenticated;
 *   2. só service_role executa `fn_aprovar_troca_de_email`; a função do gatilho não é chamável por ninguém de fora;
 *   3. trocar o e-mail de uma conta que já tem um, SEM aprovação, é recusado (42501) e o endereço fica como estava,
 *      inclusive quando quem grava é o service_role (que ignora RLS: é o caso do `PUT /auth/v1/user` do GoTrue, que
 *      grava como dono do schema auth);
 *   4. com aprovação válida a troca passa UMA vez: a aprovação é consumida e a segunda troca com ela é recusada;
 *   5. aprovação de outro endereço, de outro usuário ou vencida (mais de 1 hora) não vale;
 *   6. o que NÃO pode quebrar continua passando: cadastro (INSERT), conta sem endereço ganhando o primeiro,
 *      gravação que reescreve o mesmo endereço, só maiúsculas, outras colunas e a exclusão suave (`deleted_at`);
 *   7. (D-204) todo cadastro por e-mail e senha nasce com o pedido de verificação do CRM em aberto, qualquer que seja
 *      o caminho (INSERT direto, como o `POST /auth/v1/signup` do GoTrue faz): provider email grava o pedido no formato
 *      de `lib/auth/verificacao-email.ts`; Google não; conta de admin API com carimbo (bootstrap, parceiro) não; convite
 *      (cadastro comum) nasce em aberto e o aceite o carimba; conta que já traz pedido não é reescrita; sem a compra
 *      pelo cliente ligada nada muda;
 *   8. a migration reaplicada (atualização de quem já instalou) não falha nem duplica o gatilho.
 *
 * Roda via `pnpm test:db tests/invariants/trocar-email-so-com-aprovacao.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U1 = "09660000-0000-4000-8000-000000000001";
const U2 = "09660000-0000-4000-8000-000000000002";
const U3 = "09660000-0000-4000-8000-000000000003";

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const emailDe = (id: string) => sql(`select coalesce(email, '<null>') from auth.users where id = '${id}';`);

describe("troca de e-mail só com aprovação do servidor (0966)", () => {
  beforeAll(() => {
    // O banco de teste usa um stub de auth.users (id, email, raw_user_meta_data, created_at). `deleted_at` é coluna
    // do GoTrue real que o gatilho lê pela exclusão suave; cada arquivo de invariante tem o banco só dele.
    sql(`
      alter table auth.users add column if not exists deleted_at timestamptz;
      -- O GoTrue real tem raw_app_meta_data; o stub do banco de teste não. O gatilho de cadastro lê e grava por ela.
      alter table auth.users add column if not exists raw_app_meta_data jsonb not null default '{}'::jsonb;
      -- No Supabase real o GoTrue grava como dono do schema auth e o service_role também pode escrever; o stub só dá
      -- SELECT. Sem este grant o caso 3 mediria "permission denied" do stub, não o gatilho.
      grant update on auth.users to service_role;
      insert into auth.users (id, email) values
        ('${U1}', 'dono@exemplo.com.br'),
        ('${U2}', 'outro@exemplo.com.br'),
        ('${U3}', null)
      on conflict (id) do nothing;
    `);
  });

  it("1. aprovações: RLS ligada, nenhuma policy, anon e authenticated barrados", () => {
    expect(sql(`select relrowsecurity::text from pg_class where oid = 'public.email_trocas_aprovadas'::regclass;`)).toBe(
      "true",
    );
    expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='email_trocas_aprovadas';`)).toBe(
      "0",
    );
    for (const papel of ["anon", "authenticated"]) {
      for (const comando of [
        `select count(*) from public.email_trocas_aprovadas;`,
        `insert into public.email_trocas_aprovadas (user_id, novo_email) values ('${U1}', 'x@y.com');`,
        `update public.email_trocas_aprovadas set usado_em = now();`,
        `delete from public.email_trocas_aprovadas;`,
      ]) {
        expect(erroDe(`set role ${papel}; ${comando}`), `${papel}: ${comando}`).toMatch(/permission denied/i);
      }
    }
    // service_role só lê: aprovar passa pela função.
    expect(erroDe(`set role service_role; select count(*) from public.email_trocas_aprovadas;`)).toBeNull();
    expect(
      erroDe(`set role service_role; insert into public.email_trocas_aprovadas (user_id, novo_email) values ('${U1}', 'x@y.com');`),
    ).toMatch(/permission denied/i);
  });

  it("2. só service_role executa a aprovação; ninguém de fora executa a função do gatilho", () => {
    for (const papel of ["anon", "authenticated"]) {
      expect(erroDe(`set role ${papel}; select public.fn_aprovar_troca_de_email('${U1}', 'novo@exemplo.com.br');`)).toMatch(
        /permission denied/i,
      );
    }
    expect(erroDe(`set role service_role; select public.fn_aprovar_troca_de_email('${U1}', 'novo@exemplo.com.br');`)).toBeNull();
    sql(`delete from public.email_trocas_aprovadas;`);
    const privilegios = sql(`
      select string_agg(r.rolname, ',' order by r.rolname)
        from pg_roles r
       where r.rolname in ('anon', 'authenticated')
         and has_function_privilege(r.rolname, 'public.fn_auth_recusa_troca_de_email()', 'execute');
    `);
    expect(privilegios).toBe("");
    expect(sql(`select has_function_privilege('public', 'public.fn_auth_recusa_troca_de_email()', 'execute')::text;`)).toBe(
      "false",
    );
  });

  it("3. sem aprovação a troca é recusada, até quando quem grava é o service_role", () => {
    sql(`delete from public.email_trocas_aprovadas;`);
    const direto = erroDe(`update auth.users set email = 'atacante@exemplo.com.br' where id = '${U1}';`);
    expect(direto).toMatch(/aprova[cç][aã]o do servidor/i);
    expect(emailDe(U1)).toBe("dono@exemplo.com.br");

    const servico = erroDe(`
      set role service_role;
      update auth.users set email = 'atacante@exemplo.com.br' where id = '${U1}';
    `);
    expect(servico).toMatch(/aprova[cç][aã]o do servidor/i);
    expect(emailDe(U1)).toBe("dono@exemplo.com.br");
  });

  it("4. com aprovação a troca passa uma vez; a aprovação é consumida", () => {
    sql(`delete from public.email_trocas_aprovadas;`);
    sql(`select public.fn_aprovar_troca_de_email('${U1}', 'Novo@Exemplo.com.br');`);
    expect(erroDe(`update auth.users set email = 'novo@exemplo.com.br' where id = '${U1}';`)).toBeNull();
    expect(emailDe(U1)).toBe("novo@exemplo.com.br");
    expect(sql(`select count(*) from public.email_trocas_aprovadas where user_id = '${U1}' and usado_em is not null;`)).toBe(
      "1",
    );

    // Uso único: a mesma aprovação não paga uma segunda troca.
    expect(erroDe(`update auth.users set email = 'terceiro@exemplo.com.br' where id = '${U1}';`)).toMatch(/aprova/i);
    expect(emailDe(U1)).toBe("novo@exemplo.com.br");
    // Volta ao endereço de antes para os casos seguintes.
    sql(`select public.fn_aprovar_troca_de_email('${U1}', 'dono@exemplo.com.br');`);
    sql(`update auth.users set email = 'dono@exemplo.com.br' where id = '${U1}';`);
  });

  it("5. aprovação de outro endereço, de outro usuário ou vencida não vale", () => {
    sql(`delete from public.email_trocas_aprovadas;`);

    sql(`select public.fn_aprovar_troca_de_email('${U1}', 'combinado@exemplo.com.br');`);
    expect(erroDe(`update auth.users set email = 'diferente@exemplo.com.br' where id = '${U1}';`)).toMatch(/aprova/i);

    sql(`delete from public.email_trocas_aprovadas;`);
    sql(`select public.fn_aprovar_troca_de_email('${U2}', 'alvo@exemplo.com.br');`);
    expect(erroDe(`update auth.users set email = 'alvo@exemplo.com.br' where id = '${U1}';`)).toMatch(/aprova/i);

    sql(`delete from public.email_trocas_aprovadas;`);
    sql(`select public.fn_aprovar_troca_de_email('${U1}', 'vencida@exemplo.com.br');`);
    sql(`update public.email_trocas_aprovadas set aprovado_em = now() - interval '61 minutes';`);
    expect(erroDe(`update auth.users set email = 'vencida@exemplo.com.br' where id = '${U1}';`)).toMatch(/aprova/i);

    expect(emailDe(U1)).toBe("dono@exemplo.com.br");
    sql(`delete from public.email_trocas_aprovadas;`);
  });

  it("6. o que não pode quebrar continua passando", () => {
    // Cadastro novo (INSERT) e conta sem endereço ganhando o primeiro.
    expect(erroDe(`insert into auth.users (id, email) values ('09660000-0000-4000-8000-0000000000a1', 'novo-cadastro@exemplo.com.br');`)).toBeNull();
    expect(erroDe(`update auth.users set email = 'primeiro@exemplo.com.br' where id = '${U3}';`)).toBeNull();
    // Reescrever o mesmo endereço, só maiúsculas, e outras colunas.
    expect(erroDe(`update auth.users set email = email where id = '${U2}';`)).toBeNull();
    expect(erroDe(`update auth.users set email = 'OUTRO@exemplo.com.br' where id = '${U2}';`)).toBeNull();
    expect(erroDe(`update auth.users set raw_user_meta_data = '{"a":1}'::jsonb where id = '${U2}';`)).toBeNull();
    // Exclusão suave do GoTrue: ofusca o endereço e carimba deleted_at na mesma gravação.
    expect(
      erroDe(`update auth.users set email = 'apagado-${U2}@removido.invalid', deleted_at = now() where id = '${U2}';`),
    ).toBeNull();
    // Exclusão definitiva leva as aprovações da conta junto (FK em cascata).
    sql(`select public.fn_aprovar_troca_de_email('${U3}', 'qualquer@exemplo.com.br');`);
    sql(`delete from auth.users where id = '${U3}';`);
    expect(sql(`select count(*) from public.email_trocas_aprovadas where user_id = '${U3}';`)).toBe("0");
  });

  it("7. todo cadastro por e-mail nasce com o pedido de verificação em aberto, por qualquer caminho", () => {
    const app = (id: string) => sql(`select raw_app_meta_data::text from auth.users where id = '${id}';`);
    const pedido = (id: string) =>
      JSON.parse(
        sql(`select coalesce(raw_app_meta_data -> 'email_verificacao', 'null'::jsonb)::text from auth.users where id = '${id}';`),
      );
    const ID = (n: number) => `09660000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
    const novo = (n: number, appMeta: string, email = `cad${n}@exemplo.com.br`) =>
      sql(`insert into auth.users (id, email, raw_app_meta_data) values ('${ID(n)}', '${email}', '${appMeta}'::jsonb);`);

    // Sem a compra pelo cliente ligada (instalação comum) nada muda: não há verificação própria.
    sql(`update public.billing_settings set compra_pelo_cliente = false where id = 1;`);
    novo(1, '{"provider":"email","providers":["email"]}');
    expect(pedido(ID(1))).toBeNull();

    sql(`update public.billing_settings set compra_pelo_cliente = true where id = 1;`);

    // Cadastro por e-mail e senha, como o /auth/v1/signup direto faz: pedido gravado, no formato do CRM.
    novo(2, '{"provider":"email","providers":["email"]}');
    const p = pedido(ID(2));
    expect(p).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Number.isFinite(Date.parse(p.enviado_em))).toBe(true);
    expect(Date.parse(p.expira_em)).toBeGreaterThan(Date.parse(p.enviado_em) + 6 * 24 * 3600 * 1000);
    // O pedido não carrega token: ninguém tem o segredo, o link sai pelo "Reenviar". Dois cadastros não repetem hash.
    novo(3, '{"provider":"email","providers":["email"]}');
    expect(pedido(ID(3)).hash).not.toBe(p.hash);
    // Os outros campos do app_metadata continuam.
    expect(JSON.parse(app(ID(2)))).toMatchObject({ provider: "email", providers: ["email"] });

    // Google: sem pedido.
    novo(4, '{"provider":"google","providers":["google"]}');
    expect(pedido(ID(4))).toBeNull();

    // Admin API com carimbo (bootstrap-owner, parceiro, scripts): sem pedido, carimbo intacto.
    novo(5, '{"provider":"email","providers":["email"],"email_verificado_em":"2026-10-17T00:00:00Z"}');
    expect(pedido(ID(5))).toBeNull();
    expect(JSON.parse(app(ID(5))).email_verificado_em).toBe("2026-10-17T00:00:00Z");

    // Conta que já traz um pedido não é reescrita.
    novo(6, '{"provider":"email","email_verificacao":{"hash":"aa","expira_em":"2099-01-01T00:00:00Z","enviado_em":"2026-01-01T00:00:00Z"}}');
    expect(pedido(ID(6)).hash).toBe("aa");

    // Convite pelo cadastro comum: nasce em aberto (o aceite do convite NÃO carimba: a conta confirma o e-mail pelo CRM antes de ganhar o vínculo).
    sql(
      `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values ('${ID(7)}', 'convidado@exemplo.com.br', '{"provider":"email"}', '{"invite_token":"x"}');`,
    );
    expect(pedido(ID(7))).not.toBeNull();

    // Sem e-mail (telefone/anônimo): fora.
    sql(`insert into auth.users (id, email, raw_app_meta_data) values ('${ID(8)}', null, '{"provider":"email"}');`);
    expect(pedido(ID(8))).toBeNull();

    // Conta que já existia não muda: o gatilho é só de INSERT.
    sql(`update auth.users set raw_user_meta_data = '{"x":1}'::jsonb where id = '${ID(1)}';`);
    expect(pedido(ID(1))).toBeNull();

    // Leitura da configuração que falha não desliga a regra: com a tabela indisponível, abre o pedido.
    sql(`alter table public.billing_settings rename to billing_settings_fora;`);
    novo(9, '{"provider":"email"}');
    sql(`alter table public.billing_settings_fora rename to billing_settings;`);
    expect(pedido(ID(9))).not.toBeNull();

    sql(`update public.billing_settings set compra_pelo_cliente = false where id = 1;`);
  });

  it("8. a migration reaplicada não falha e deixa um gatilho só", () => {
    const arquivo = resolve(
      process.cwd(),
      "supabase/migrations/20261017150000_0966_trocar_email_so_com_aprovacao_do_servidor.sql",
    );
    const script = readFileSync(arquivo, "utf8");
    expect(erroDe(script)).toBeNull();
    expect(erroDe(script)).toBeNull();
    expect(
      sql(`select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname in ('trg_auth_users_recusa_troca_de_email', 'trg_auth_users_abre_verificacao_do_cadastro') and not tgisinternal;`),
    ).toBe("2");
    // E ele continua recusando.
    expect(erroDe(`update auth.users set email = 'sem-aprovacao@exemplo.com.br' where id = '${U1}';`)).toMatch(/aprova/i);
  });
});
