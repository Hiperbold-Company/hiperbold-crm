/**
 * `meta_social_envios` (0987) É SERVER-SIDE ONLY.
 *
 * Os mids que a Meta devolveu nos envios do canal social oficial, para a
 * ingestão reconhecer o eco do próprio envio. Só o servidor (service role)
 * grava (adapter) e lê (ingestão), filtrando `organization_id` à mão. Mesmo
 * desenho deny-all de `captura-de-clique-e-server-side.test.ts`: RLS ligada,
 * zero policies, grants revogados — por isso a tabela não está em
 * `rls-isolation.test.ts` (lá ela daria `permission denied`, e "consertar" com
 * policy a exporia pelo PostgREST).
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELA = "meta_social_envios";

function privilegiosDe(papel: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${TABELA}' and grantee = '${papel}';
  `).trim();
}

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("o PostgREST não serve meta_social_envios", () => {
  it("a tabela existe no baseline (controle positivo)", () => {
    expect(
      sql(`select count(*) from information_schema.tables where table_schema='public' and table_name='${TABELA}';`).trim(),
    ).toBe("1");
  });

  it("anon e authenticated sem privilégio nenhum; service_role com o que usa", () => {
    expect(privilegiosDe("anon")).toBe("NENHUM");
    expect(privilegiosDe("authenticated")).toBe("NENHUM");
    const sr = privilegiosDe("service_role");
    for (const p of ["SELECT", "INSERT", "DELETE"]) expect(sr).toContain(p);
  });

  it("anon e authenticated são BARRADOS ao ler (permission denied, não zero linhas)", () => {
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroSob(papel, `select mid from public.${TABELA}`);
      expect(erro, `${papel} leu a tabela`).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("RLS ligada e nenhuma policy", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${TABELA}'::regclass;`).trim()).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${TABELA}';`).trim()).toBe("0");
  });

  it("chave primária (organization_id, mid): é a pergunta exata da ingestão", () => {
    const cols = sql(`
      select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.conrelid = 'public.${TABELA}'::regclass and c.contype = 'p';
    `).trim();
    expect(cols).toBe("organization_id,mid");
  });
});

describe("meta_data_deletion_requests: um pedido aberto por rede e pessoa", () => {
  it("o índice único parcial existe e recusa o segundo aberto", () => {
    const idx = sql(`
      select count(*) from pg_indexes where schemaname='public'
        and indexname='meta_data_deletion_requests_aberto_uidx';
    `).trim();
    expect(idx).toBe("1");
    let erro: string | null = null;
    try {
      sql(`
        begin;
        insert into public.meta_data_deletion_requests (confirmation_code, platform, meta_user_id) values ('c-1-${Date.now()}', 'instagram', 'U-IDX');
        insert into public.meta_data_deletion_requests (confirmation_code, platform, meta_user_id) values ('c-2-${Date.now()}', 'instagram', 'U-IDX');
        rollback;
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toMatch(/duplicate key|unique/);
    // Concluído não ocupa a vaga.
    const ok = sql(`
      begin;
      insert into public.meta_data_deletion_requests (confirmation_code, platform, meta_user_id, status) values ('c-3-${Date.now()}', 'instagram', 'U-IDX2', 'completed');
      insert into public.meta_data_deletion_requests (confirmation_code, platform, meta_user_id) values ('c-4-${Date.now()}', 'instagram', 'U-IDX2');
      select count(*) from public.meta_data_deletion_requests where meta_user_id = 'U-IDX2';
      rollback;
    `);
    expect(ok).toContain("2");
  });
});
