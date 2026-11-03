/**
 * COMENTÁRIOS DO INSTAGRAM E A FILA DE RESPOSTA (migration 0991).
 *
 *  - Isolamento: dois tenants reais por JWT (`set role authenticated` +
 *    `request.jwt.claims`; como `postgres` a RLS não seria medida). Cada um lê
 *    só o que é seu, nas duas tabelas, e ZERO do vizinho nos dois sentidos.
 *  - Escrita só do servidor: `authenticated` não grava, `anon` não tem nada.
 *  - `fn_meta_social_registrar_comentario`: grava a linha e emite UM evento
 *    com o payload do contrato; repetido não emite; sessão de outra
 *    organização é recusada; fora do alcance de anon e authenticated.
 *  - A fila aceita um envio por comentário por tipo.
 *
 * Arquivo próprio (não `rls-isolation.test.ts`): a varredura
 * `rls-completude-varredura.test.ts` aponta para cá em `PROVA_PROPRIA`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { CAMPOS_DO_EVENTO_COMENTARIO } from "@/lib/channels/meta-social/comentarios-contrato";
import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "09910991-0000-4000-8000-00000000000a";
const ORG_B = "09910991-0000-4000-8000-00000000000b";
const USER_A = "09910991-1111-4000-8000-00000000000a";
const USER_B = "09910991-1111-4000-8000-00000000000b";
const SESSAO_A = "09910991-2222-4000-8000-00000000000a";
const SESSAO_B = "09910991-2222-4000-8000-00000000000b";
const TABELAS = ["meta_social_comentarios", "meta_social_fila_de_envio"] as const;
const ASSINATURA = "uuid, uuid, text, text, text, text, text, text, timestamptz";

const ultima = (s: string) => s.split("\n").pop() ?? "";

function como(usuario: string, comando: string): string {
  try {
    return ultima(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        ${comando}
      `),
    );
  } catch (err) {
    return `ERRO: ${motivoDoErro(err)}`;
  }
}

function registrar(org: string, sessao: string, commentId: string): string {
  return ultima(
    sql(`select coalesce(public.fn_meta_social_registrar_comentario(
      '${org}', '${sessao}', '${commentId}', 'MEDIA-1', 'REELS', 'IGSID-1', 'maria', 'quero',
      now() - interval '1 minute')::text, 'null');`),
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'ig-com-a@invariant.test'), ('${USER_B}', 'ig-com-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ig-com-a', 'IG Com A', 'IG Com A'), ('${ORG_B}', 'ig-com-b', 'IG Com B', 'IG Com B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()), ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, provider, meta_social_platform, meta_social_account_id, webhook_secret_encrypted) values
      ('${SESSAO_A}', '${ORG_A}', 'meta_social', 'instagram', 'IG-0991-A', '\\x00'::bytea),
      ('${SESSAO_B}', '${ORG_B}', 'meta_social', 'instagram', 'IG-0991-B', '\\x00'::bytea)
      on conflict (id) do nothing;
  `);
  registrar(ORG_A, SESSAO_A, "C-0991-A");
  registrar(ORG_B, SESSAO_B, "C-0991-B");
  sql(`
    insert into public.meta_social_fila_de_envio (organization_id, channel_session_id, tipo, comment_id, texto) values
      ('${ORG_A}', '${SESSAO_A}', 'resposta_privada', 'C-0991-A', 'oi A'),
      ('${ORG_B}', '${SESSAO_B}', 'resposta_privada', 'C-0991-B', 'oi B')
      on conflict do nothing;
  `);
});

describe("isolamento entre organizações", () => {
  for (const tabela of TABELAS) {
    it(`${tabela}: cada um lê o seu (controle positivo) e zero do vizinho, nos dois sentidos`, () => {
      expect(como(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBe("1");
      expect(como(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe("1");
      expect(como(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe("0");
      expect(como(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBe("0");
      expect(como(USER_A, `select count(*) from public.${tabela};`)).toBe(
        como(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`),
      );
    });

    it(`${tabela}: authenticated não grava nem na própria organização; anon sem privilégio`, () => {
      expect(como(USER_A, `delete from public.${tabela} where organization_id = '${ORG_A}';`)).toMatch(/permission denied/);
      expect(como(USER_A, `update public.${tabela} set comment_id = 'x' where organization_id = '${ORG_A}';`)).toMatch(
        /permission denied/,
      );
      expect(
        sql(`select count(*) from information_schema.role_table_grants
              where table_schema='public' and table_name='${tabela}' and grantee='anon';`),
      ).toBe("0");
      expect(
        sql(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
              where table_schema='public' and table_name='${tabela}' and grantee='authenticated';`),
      ).toBe("SELECT");
      expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${tabela}'
                   and policyname='tenant_isolation_${tabela}_select' and cmd='SELECT';`)).toBe("1");
    });
  }
});

describe("fn_meta_social_registrar_comentario", () => {
  it("grava uma linha e UM evento com o payload do contrato; repetido devolve null e não emite", () => {
    const id = registrar(ORG_A, SESSAO_A, "C-0991-NOVO");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(registrar(ORG_A, SESSAO_A, "C-0991-NOVO")).toBe("null");
    expect(
      sql(`select count(*) from public.meta_social_comentarios where organization_id='${ORG_A}' and comment_id='C-0991-NOVO';`),
    ).toBe("1");
    const eventos = sql(`select count(*) from public.event_log where organization_id='${ORG_A}'
                           and event_type='instagram.comentario_recebido' and entity_id='${id}';`);
    expect(eventos).toBe("1");
    const chaves = sql(`select string_agg(k, ',' order by k) from public.event_log e, jsonb_object_keys(e.payload) k
                          where e.entity_id='${id}' and e.event_type='instagram.comentario_recebido';`);
    expect(chaves).toBe([...CAMPOS_DO_EVENTO_COMENTARIO].sort().join(","));
    expect(sql(`select entity_kind || '|' || (payload->>'comment_id') || '|' || (payload->>'autor_id')
                  from public.event_log where entity_id='${id}';`)).toBe("instagram_comment|C-0991-NOVO|IGSID-1");
  });

  it("a mesma conta comentada em outra organização não colide (único por organização)", () => {
    expect(registrar(ORG_B, SESSAO_B, "C-0991-NOVO")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sessão de outra organização é recusada", () => {
    let erro = "";
    try {
      registrar(ORG_A, SESSAO_B, "C-0991-CRUZADO");
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toContain("meta_social_sessao_de_outra_organizacao");
    expect(sql(`select count(*) from public.meta_social_comentarios where comment_id='C-0991-CRUZADO';`)).toBe("0");
  });

  it("só service_role executa (anon e authenticated não, pelas duas origens)", () => {
    for (const papel of ["anon", "authenticated", "public"]) {
      const pode = sql(
        papel === "public"
          ? `select count(*) from information_schema.routine_privileges where routine_schema='public'
               and routine_name='fn_meta_social_registrar_comentario' and grantee='PUBLIC';`
          : `select has_function_privilege('${papel}', 'public.fn_meta_social_registrar_comentario(${ASSINATURA})', 'execute')::text;`,
      );
      expect(pode, papel).toBe(papel === "public" ? "0" : "false");
    }
    expect(
      sql(`select has_function_privilege('service_role', 'public.fn_meta_social_registrar_comentario(${ASSINATURA})', 'execute')::text;`),
    ).toBe("true");
  });
});

describe("a fila: um envio por comentário por tipo", () => {
  it("o segundo pedido do mesmo tipo é recusado pelo único; o outro tipo entra", () => {
    let erro = "";
    try {
      sql(`insert into public.meta_social_fila_de_envio (organization_id, channel_session_id, tipo, comment_id, texto)
             values ('${ORG_A}', '${SESSAO_A}', 'resposta_privada', 'C-0991-A', 'de novo');`);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toMatch(/duplicate key|unique/);
    expect(
      sql(`begin;
           insert into public.meta_social_fila_de_envio (organization_id, channel_session_id, tipo, comment_id, texto)
             values ('${ORG_A}', '${SESSAO_A}', 'resposta_publica', 'C-0991-A', 'em público');
           select count(*) from public.meta_social_fila_de_envio where organization_id='${ORG_A}' and comment_id='C-0991-A';
           rollback;`),
    ).toContain("2");
  });
});
