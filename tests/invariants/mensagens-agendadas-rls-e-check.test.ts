import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * MENSAGEM AGENDADA (migration 1017): isolamento entre duas organizações, o
 * privilégio do tamanho do uso, o CHECK do status e a reserva que não entrega
 * a mesma linha duas vezes.
 *
 * O que se prova, contra o Postgres do `pnpm test:db` (baseline aplicado):
 *
 *   1. cada atendente lê a agendada da PRÓPRIA organização, e nada da outra;
 *   2. `authenticated` não escreve nada direto na tabela (só SELECT): nem na
 *      própria organização. Quem escreve é o servidor, pelas rotas;
 *   3. `anon` não lê;
 *   4. o CHECK recusa status fora do vocabulário (o par TypeScript é cobrado por
 *      `vocabulario-banco-x-typescript.test.ts`), texto vazio e modelo que não é objeto;
 *   5. `fn_reservar_mensagens_agendadas` só é executável por `service_role`,
 *      reserva a vencida, pula a futura, a adiada e a da organização parada, e
 *      a segunda chamada não devolve de novo a que a primeira reservou.
 */

const ORG_A = "1017aaaa-0000-4000-8000-000000000001";
const ORG_B = "1017bbbb-0000-4000-8000-000000000002";
const USER_A = "1017aaaa-1111-4000-8000-000000000001";
const USER_B = "1017bbbb-1111-4000-8000-000000000002";
const SESS_A = "1017aaaa-2222-4000-8000-000000000001";
const SESS_B = "1017bbbb-2222-4000-8000-000000000002";
const CT_A = "1017aaaa-3333-4000-8000-000000000001";
const CT_B = "1017bbbb-3333-4000-8000-000000000002";
const CV_A = "1017aaaa-4444-4000-8000-000000000001";
const CV_B = "1017bbbb-4444-4000-8000-000000000002";
const SM_A = "1017aaaa-5555-4000-8000-000000000001";
const SM_B = "1017bbbb-5555-4000-8000-000000000002";
const SM_A_FUTURA = "1017aaaa-5555-4000-8000-000000000003";
const SM_A_ADIADA = "1017aaaa-5555-4000-8000-000000000004";

function semear(org: string, user: string, sess: string, ct: string, cv: string, sm: string, tag: string): string {
  return `
    insert into auth.users (id, email) values ('${user}', 'sm-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'sm-inv-${tag}', 'Agendadas Inv ${tag}', 'SM ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'sm-inv-${tag}', '\\x00'::bytea)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${ct}', '${org}', 'Agendadas Inv Contact ${tag}')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id)
      values ('${cv}', '${org}', '${ct}', '${sess}')
      on conflict (id) do nothing;
    insert into public.scheduled_messages
      (id, organization_id, conversation_id, contact_id, channel_session_id, created_by, body, send_at)
      values ('${sm}', '${org}', '${cv}', '${ct}', '${sess}', '${user}', 'oi ${tag}', now() - interval '1 minute')
      on conflict (id) do nothing;
  `;
}

/** Roda e devolve o stderr da recusa (string vazia se passou). */
function recusa(script: string): string {
  try {
    sql(script);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

beforeAll(() => {
  sql(
    semear(ORG_A, USER_A, SESS_A, CT_A, CV_A, SM_A, "a") +
      semear(ORG_B, USER_B, SESS_B, CT_B, CV_B, SM_B, "b") +
      `
      insert into public.scheduled_messages
        (id, organization_id, conversation_id, created_by, body, send_at)
        values ('${SM_A_FUTURA}', '${ORG_A}', '${CV_A}', '${USER_A}', 'futura', now() + interval '1 day')
        on conflict (id) do nothing;
      insert into public.scheduled_messages
        (id, organization_id, conversation_id, created_by, body, send_at, adiada_ate)
        values ('${SM_A_ADIADA}', '${ORG_A}', '${CV_A}', '${USER_A}', 'adiada', now() - interval '1 hour', now() + interval '8 hours')
        on conflict (id) do nothing;
    `,
  );
});

describe("RLS de scheduled_messages entre duas organizações", () => {
  it("controle positivo: cada atendente lê a agendada da própria organização", () => {
    expect(countAs(USER_A, `select count(*) from public.scheduled_messages where id = '${SM_A}';`)).toBe(1);
    expect(countAs(USER_B, `select count(*) from public.scheduled_messages where id = '${SM_B}';`)).toBe(1);
  });

  it("atendente de A não lê nada de B, e o de B nada de A", () => {
    expect(
      countAs(USER_A, `select count(*) from public.scheduled_messages where organization_id = '${ORG_B}';`),
    ).toBe(0);
    expect(
      countAs(USER_B, `select count(*) from public.scheduled_messages where organization_id = '${ORG_A}';`),
    ).toBe(0);
  });
});

describe("privilégio do tamanho do uso", () => {
  const comoAtendente = (dml: string) => `
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
    ${dml};
  `;

  it("authenticated não insere, não altera e não apaga nem na própria organização", () => {
    expect(
      recusa(
        comoAtendente(`insert into public.scheduled_messages (organization_id, conversation_id, body, send_at)
           values ('${ORG_A}', '${CV_A}', 'direto', now() + interval '1 hour')`),
      ),
    ).toMatch(/permission denied/);
    expect(
      recusa(comoAtendente(`update public.scheduled_messages set body = 'mexi' where id = '${SM_A}'`)),
    ).toMatch(/permission denied/);
    expect(recusa(comoAtendente(`delete from public.scheduled_messages where id = '${SM_A}'`))).toMatch(
      /permission denied/,
    );
    expect(lastLine(sql(`select body from public.scheduled_messages where id = '${SM_A}';`))).toBe("oi a");
  });

  it("anon não lê", () => {
    expect(recusa(`set role anon; select count(*) from public.scheduled_messages;`)).toMatch(/permission denied/);
  });

  it("a reserva é só do service_role", () => {
    const fn = "public.fn_reservar_mensagens_agendadas(integer, uuid[])";
    expect(
      lastLine(
        sql(`select has_function_privilege('anon', '${fn}', 'execute')::text
               || ',' || has_function_privilege('authenticated', '${fn}', 'execute')::text
               || ',' || has_function_privilege('service_role', '${fn}', 'execute')::text;`),
      ),
    ).toBe("false,false,true");
  });
});

describe("CHECK de scheduled_messages", () => {
  const inserir = (extra: string, valores: string) =>
    recusa(`insert into public.scheduled_messages (organization_id, conversation_id, body, send_at${extra})
              values ('${ORG_A}', '${CV_A}', ${valores});`);

  it("recusa status fora do vocabulário", () => {
    expect(inserir(", status", `'x', now(), 'pendente'`)).toMatch(/scheduled_messages_status_check/);
  });

  it("aceita os cinco status do vocabulário (controle positivo)", () => {
    for (const status of ["agendada", "enviando", "enviada", "cancelada", "falhou"]) {
      expect(
        recusa(`begin;
          insert into public.scheduled_messages (organization_id, conversation_id, body, send_at, status)
            values ('${ORG_A}', '${CV_A}', 'x', now() + interval '1 year', '${status}');
          rollback;`),
      ).toBe("");
    }
  });

  it("recusa texto vazio e modelo que não é objeto", () => {
    expect(inserir("", `'', now()`)).toMatch(/scheduled_messages_body_check/);
    expect(inserir(", template", `'x', now(), '["nome"]'::jsonb`)).toMatch(/scheduled_messages_template_check/);
  });
});

describe("fn_reservar_mensagens_agendadas", () => {
  function reservar(paradas: string[]): string[] {
    const arr = paradas.length ? `array[${paradas.map((p) => `'${p}'::uuid`).join(",")}]` : `'{}'::uuid[]`;
    const out = sql(`select id from public.fn_reservar_mensagens_agendadas(50, ${arr})
                      where organization_id in ('${ORG_A}', '${ORG_B}') order by id;`);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  it("reserva a vencida, pula a futura, a adiada e a da organização parada; a segunda chamada não repete", () => {
    const primeira = reservar([ORG_B]);
    expect(primeira).toEqual([SM_A]);
    expect(lastLine(sql(`select status || ',' || (reservada_em is not null)::text from public.scheduled_messages where id = '${SM_A}';`))).toBe(
      "enviando,true",
    );
    expect(reservar([ORG_B])).toEqual([]);
    expect(lastLine(sql(`select status from public.scheduled_messages where id = '${SM_B}';`))).toBe("agendada");
    expect(lastLine(sql(`select status from public.scheduled_messages where id = '${SM_A_FUTURA}';`))).toBe("agendada");
    expect(lastLine(sql(`select status from public.scheduled_messages where id = '${SM_A_ADIADA}';`))).toBe("agendada");
  });

  it("linha travada por outra transação é pulada (skip locked), não esperada", () => {
    // B está agendada e vencida. Uma transação segura o lock da linha enquanto
    // outra sessão pede a reserva: ela volta vazia em vez de esperar.
    const container = process.env.TEST_DB_CONTAINER!;
    const segura = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        `psql -U postgres -d postgres -tA -c "begin; select id from public.scheduled_messages where id = '${SM_B}' for update; select pg_sleep(3); commit;" >/dev/null & ` +
          `sleep 1; psql -U postgres -d postgres -tA -c "select count(*) from public.fn_reservar_mensagens_agendadas(50, '{}'::uuid[]) where id = '${SM_B}';"; wait`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(lastLine(segura)).toBe("0");
    expect(lastLine(sql(`select status from public.scheduled_messages where id = '${SM_B}';`))).toBe("agendada");
  });
});

describe("a agendada herda a visibilidade da conversa (auditoria do lote 17/11)", () => {
  // Org com visibility_mode = 'own': o atendente só vê a conversa atribuída a ele. A agendada de
  // uma conversa de OUTRO atendente, na mesma organização, não pode aparecer pela REST.
  const ORG_V = "1017cccc-0000-4000-8000-000000000003";
  const USER_V = "1017cccc-1111-4000-8000-000000000003";
  const USER_V2 = "1017cccc-1111-4000-8000-000000000004";
  const SESS_V = "1017cccc-2222-4000-8000-000000000003";
  const CT_V = "1017cccc-3333-4000-8000-000000000003";
  const CT_V2 = "1017cccc-3333-4000-8000-000000000004";
  const CV_DELE = "1017cccc-4444-4000-8000-000000000003";
  const CV_DO_OUTRO = "1017cccc-4444-4000-8000-000000000004";
  const SM_DELE = "1017cccc-5555-4000-8000-000000000003";
  const SM_DO_OUTRO = "1017cccc-5555-4000-8000-000000000004";

  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${USER_V}', 'sm-v@invariant.test'), ('${USER_V2}', 'sm-v2@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name, settings)
        values ('${ORG_V}', 'sm-inv-v', 'Agendadas Inv V', 'SM V', '{"visibility_mode": "own"}')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${USER_V}', '${ORG_V}', 'agent', now()), ('${USER_V2}', '${ORG_V}', 'agent', now())
        on conflict do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESS_V}', '${ORG_V}', 'sm-inv-v', '\\x00'::bytea) on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, display_name)
        values ('${CT_V}', '${ORG_V}', 'Agendadas Inv Contact V'), ('${CT_V2}', '${ORG_V}', 'Agendadas Inv Contact V2')
        on conflict (id) do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, assigned_to_user_id) values
        ('${CV_DELE}', '${ORG_V}', '${CT_V}', '${SESS_V}', '${USER_V}'),
        ('${CV_DO_OUTRO}', '${ORG_V}', '${CT_V2}', '${SESS_V}', '${USER_V2}')
        on conflict (id) do nothing;
      insert into public.scheduled_messages (id, organization_id, conversation_id, contact_id, created_by, body, send_at) values
        ('${SM_DELE}', '${ORG_V}', '${CV_DELE}', '${CT_V}', '${USER_V}', 'minha', now() + interval '1 day'),
        ('${SM_DO_OUTRO}', '${ORG_V}', '${CV_DO_OUTRO}', '${CT_V2}', '${USER_V2}', 'do outro', now() + interval '1 day')
        on conflict (id) do nothing;
    `);
  });

  it("controle positivo: o atendente lê a agendada da conversa dele", () => {
    expect(countAs(USER_V, `select count(*) from public.scheduled_messages where id = '${SM_DELE}';`)).toBe(1);
  });

  it("não lê a agendada da conversa de outro atendente da mesma organização", () => {
    expect(countAs(USER_V, `select count(*) from public.scheduled_messages where id = '${SM_DO_OUTRO}';`)).toBe(0);
  });
});

describe("o service_role tem só o que usa em scheduled_messages", () => {
  it("sem TRUNCATE, REFERENCES nem TRIGGER (o revoke all inclui service_role)", () => {
    expect(
      lastLine(
        sql(`select coalesce(string_agg(privilege_type, ',' order by privilege_type), '')
               from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'scheduled_messages'
                and grantee = 'service_role';`),
      ),
    ).toBe("DELETE,INSERT,SELECT,UPDATE");
  });
});

describe("anonimizar o contato alcança a agendada (LGPD)", () => {
  const ORG_L = "1017dddd-0000-4000-8000-000000000005";
  const SESS_L = "1017dddd-2222-4000-8000-000000000005";
  const CT_L = "1017dddd-3333-4000-8000-000000000005";
  const CT_VIZINHO = "1017dddd-3333-4000-8000-000000000006";
  const CV_L = "1017dddd-4444-4000-8000-000000000005";
  const CV_VIZINHO = "1017dddd-4444-4000-8000-000000000006";
  const SM_PENDENTE = "1017dddd-5555-4000-8000-000000000005";
  const SM_ENVIADA = "1017dddd-5555-4000-8000-000000000006";
  const SM_VIZINHO = "1017dddd-5555-4000-8000-000000000007";

  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_L}', 'sm-inv-l', 'Agendadas Inv L', 'SM L') on conflict (id) do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESS_L}', '${ORG_L}', 'sm-inv-l', '\\x00'::bytea) on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, display_name) values
        ('${CT_L}', '${ORG_L}', 'Titular L'), ('${CT_VIZINHO}', '${ORG_L}', 'Vizinho L')
        on conflict (id) do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
        ('${CV_L}', '${ORG_L}', '${CT_L}', '${SESS_L}'), ('${CV_VIZINHO}', '${ORG_L}', '${CT_VIZINHO}', '${SESS_L}')
        on conflict (id) do nothing;
      insert into public.scheduled_messages (id, organization_id, conversation_id, contact_id, body, template, send_at, status) values
        ('${SM_PENDENTE}', '${ORG_L}', '${CV_L}', '${CT_L}', 'Oi Maria, sua consulta', '{"name":"lembrete","values":["Maria"]}', now() + interval '1 day', 'agendada'),
        ('${SM_ENVIADA}', '${ORG_L}', '${CV_L}', null, 'Oi Maria, chegou', null, now() - interval '1 day', 'enviada'),
        ('${SM_VIZINHO}', '${ORG_L}', '${CV_VIZINHO}', '${CT_VIZINHO}', 'Oi João', null, now() + interval '1 day', 'agendada')
        on conflict (id) do nothing;
    `);
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_L}', '${CT_L}', null);`);
  });

  it("a pendente vira cancelada, com o texto redigido e o modelo zerado", () => {
    expect(
      lastLine(sql(`select status || '|' || body || '|' || coalesce(template::text, 'null') from public.scheduled_messages where id = '${SM_PENDENTE}';`)),
    ).toBe("cancelada|[mensagem anonimizada]|null");
  });

  it("a já enviada (achada pela conversa, sem contact_id) mantém o status e perde o texto", () => {
    expect(lastLine(sql(`select status || '|' || body from public.scheduled_messages where id = '${SM_ENVIADA}';`))).toBe(
      "enviada|[mensagem anonimizada]",
    );
  });

  it("CONTROLE: a agendada do vizinho fica intacta", () => {
    expect(lastLine(sql(`select status || '|' || body from public.scheduled_messages where id = '${SM_VIZINHO}';`))).toBe(
      "agendada|Oi João",
    );
  });
});
