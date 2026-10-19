import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0971 — `fn_excluir_contatos_em_lote`: a exclusão de contatos em lote é tudo-ou-nada,
 * contra Postgres real.
 *
 * O que a função tem de garantir (e a rota não consegue sozinha): mensagens, conversas e ficha de
 * um bloco saem na MESMA transação. Se qualquer passo é recusado, nenhum contato do bloco fica com
 * o histórico apagado e a ficha de pé.
 *
 * Namespace 0971aaaa = exclusivo deste arquivo (cada arquivo roda em banco próprio).
 */
const ORG = "0971aaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "0971aaaa-0000-4000-8000-000000000002";
const GERENTE = "0971aaaa-1111-4000-8000-000000000001";
const ATENDENTE = "0971aaaa-1111-4000-8000-000000000002";
const SESSAO = "0971aaaa-2222-4000-8000-000000000001";
const SESSAO_B = "0971aaaa-2222-4000-8000-000000000002";
const c = (n: number) => `0971aaaa-3333-4000-8000-${String(n).padStart(12, "0")}`;

const C_VIVO = c(1);
const C_AGENDA = c(2);
const C_ANONIMO = c(3);
const C_LAPIDE = c(4);
const C_OK_DO_BLOCO = c(5);
const C_QUE_FALHA = c(6);
const C_OUTRA_ORG = c(7);
const PIPELINE = "0971aaaa-5555-4000-8000-000000000001";
const STAGE = "0971aaaa-5555-4000-8000-000000000002";
const LEAD = "0971aaaa-6666-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE}', 'lote-g@invariant.test'), ('${ATENDENTE}', 'lote-a@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'lote-a', 'Lote A', 'Lote A'), ('${OUTRA_ORG}', 'lote-b', 'Lote B', 'Lote B') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG}', 'manager', now()), ('${ATENDENTE}', '${ORG}', 'agent', now()) on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSAO}', '${ORG}', 'lote-a', '\\x00'::bytea), ('${SESSAO_B}', '${OUTRA_ORG}', 'lote-b', '\\x00'::bytea)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, is_anonymized, anonymized_at, is_merged_into) values
      ('${C_VIVO}', '${ORG}', 'Vivo', false, null, null),
      ('${C_AGENDA}', '${ORG}', 'Com agenda', false, null, null),
      ('${C_ANONIMO}', '${ORG}', 'Anonimizado', true, now(), null),
      ('${C_LAPIDE}', '${ORG}', 'Lápide', false, null, '${C_AGENDA}'),
      ('${C_OK_DO_BLOCO}', '${ORG}', 'Bloco ok', false, null, null),
      ('${C_QUE_FALHA}', '${ORG}', 'Bloco falha', false, null, null),
      ('${C_OUTRA_ORG}', '${OUTRA_ORG}', 'De outra org', false, null, null) on conflict do nothing;
    insert into public.conversations (organization_id, channel_session_id, contact_id)
      select o, s, ct from (values
        ('${ORG}'::uuid, '${SESSAO}'::uuid, '${C_VIVO}'::uuid),
        ('${ORG}', '${SESSAO}', '${C_AGENDA}'),
        ('${ORG}', '${SESSAO}', '${C_ANONIMO}'),
        ('${ORG}', '${SESSAO}', '${C_OK_DO_BLOCO}'),
        ('${ORG}', '${SESSAO}', '${C_QUE_FALHA}'),
        ('${OUTRA_ORG}', '${SESSAO_B}', '${C_OUTRA_ORG}')) v(o, s, ct);
    insert into public.messages (organization_id, channel_session_id, conversation_id, contact_id, type, direction)
      select cv.organization_id, cv.channel_session_id, cv.id, cv.contact_id, 'text', 'inbound'
        from public.conversations cv where cv.organization_id in ('${ORG}', '${OUTRA_ORG}');
    insert into public.calendar_appointments (organization_id, contact_id, title, starts_at, ends_at)
      values ('${ORG}', '${C_AGENDA}', 'Consulta', now(), now() + interval '1 hour');
    insert into public.crm_pipelines (id, organization_id, name, slug) values ('${PIPELINE}', '${ORG}', 'Funil', 'funil-lote');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000);
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${LEAD}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio do vivo', '${C_VIVO}');
  `);
});

/** Chama a função como o usuário autenticado (JWT simulado), como o PostgREST faz. */
function chamar(userId: string, org: string, ids: string[]): string {
  const lista = ids.map((i) => `'${i}'`).join(",");
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select 'R:' || coalesce(array_to_string(public.fn_excluir_contatos_em_lote('${org}', array[${lista}]::uuid[]), ','), '');
  `);
  const linha = out.split("\n").find((l) => l.startsWith("R:"));
  if (linha === undefined) throw new Error(`saída inesperada: ${out}`);
  return linha.slice(2);
}

function existe(tabela: string, coluna: string, valor: string): boolean {
  return sql(`select exists(select 1 from public.${tabela} where ${coluna} = '${valor}');`) === "t";
}

describe("0971 — fn_excluir_contatos_em_lote", () => {
  it("gerente apaga mensagens, conversas e ficha numa só chamada; o negócio fica, sem contato", () => {
    expect(chamar(GERENTE, ORG, [C_VIVO])).toBe(C_VIVO);
    expect(existe("contacts", "id", C_VIVO)).toBe(false);
    expect(existe("messages", "contact_id", C_VIVO)).toBe(false);
    expect(existe("conversations", "contact_id", C_VIVO)).toBe(false);
    // `on delete set null`: o negócio continua, sem contato (igual à lixeira de uma linha)
    expect(sql(`select (contact_id is null)::text from public.crm_leads where id = '${LEAD}';`)).toBe("true");
  });

  it("deixa de fora, sem tocar em nada: compromisso na agenda, anonimizado e lápide de fusão", () => {
    expect(chamar(GERENTE, ORG, [C_AGENDA, C_ANONIMO, C_LAPIDE])).toBe("");
    for (const ct of [C_AGENDA, C_ANONIMO, C_LAPIDE]) expect(existe("contacts", "id", ct)).toBe(true);
    for (const ct of [C_AGENDA, C_ANONIMO]) {
      expect(existe("messages", "contact_id", ct)).toBe(true);
      expect(existe("conversations", "contact_id", ct)).toBe(true);
    }
  });

  it("ISOLAMENTO: id de outra organização não é apagado, nem o histórico dele", () => {
    expect(chamar(GERENTE, ORG, [C_OUTRA_ORG])).toBe("");
    expect(existe("contacts", "id", C_OUTRA_ORG)).toBe(true);
    expect(existe("messages", "contact_id", C_OUTRA_ORG)).toBe(true);
  });

  it("atendente é recusado pelo próprio banco (piso gerente) e nada é tocado", () => {
    expect(() => chamar(ATENDENTE, ORG, [C_OK_DO_BLOCO])).toThrow(/insufficient_role/);
    expect(existe("contacts", "id", C_OK_DO_BLOCO)).toBe(true);
    expect(existe("messages", "contact_id", C_OK_DO_BLOCO)).toBe(true);
  });

  it("gerente de OUTRA organização não apaga contato desta: o piso é por organização", () => {
    // o gerente desta org pedindo a org B: sem papel lá
    expect(() => chamar(GERENTE, OUTRA_ORG, [C_OUTRA_ORG])).toThrow(/insufficient_role/);
    expect(existe("contacts", "id", C_OUTRA_ORG)).toBe(true);
  });

  it("TUDO-OU-NADA: se a exclusão de UMA ficha falha, o bloco inteiro volta (ninguém fica meio apagado)", () => {
    sql(`
      create or replace function public.__lote_teste_trava() returns trigger language plpgsql as $$
      begin raise exception 'trava do teste'; end $$;
      create trigger __lote_teste_trava before delete on public.contacts
        for each row when (old.id = '${C_QUE_FALHA}') execute function public.__lote_teste_trava();
    `);
    try {
      expect(() => chamar(GERENTE, ORG, [C_OK_DO_BLOCO, C_QUE_FALHA])).toThrow(/trava do teste/);
      for (const ct of [C_OK_DO_BLOCO, C_QUE_FALHA]) {
        expect(existe("contacts", "id", ct), `ficha ${ct}`).toBe(true);
        expect(existe("messages", "contact_id", ct), `mensagens ${ct}`).toBe(true);
        expect(existe("conversations", "contact_id", ct), `conversas ${ct}`).toBe(true);
      }
    } finally {
      sql(`drop trigger if exists __lote_teste_trava on public.contacts; drop function if exists public.__lote_teste_trava();`);
    }
    // sem a trava, o mesmo bloco passa
    expect(chamar(GERENTE, ORG, [C_OK_DO_BLOCO, C_QUE_FALHA]).split(",").sort()).toEqual([C_OK_DO_BLOCO, C_QUE_FALHA].sort());
  });

  it("mais de 100 ids por chamada é recusado", () => {
    const muitos = Array.from({ length: 101 }, (_, i) => c(1000 + i));
    expect(() => chamar(GERENTE, ORG, muitos)).toThrow(/lote_grande_demais/);
  });

  it("EXECUTE: anon e PUBLIC não alcançam; authenticated sim", () => {
    const f = "public.fn_excluir_contatos_em_lote(uuid, uuid[])";
    expect(sql(`select has_function_privilege('anon', '${f}', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', '${f}', 'execute');`)).toBe("t");
    expect(
      sql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = '${f}'::regprocedure and a.grantee = 0;`),
    ).toBe("0"); // grantee 0 = PUBLIC
  });
});
