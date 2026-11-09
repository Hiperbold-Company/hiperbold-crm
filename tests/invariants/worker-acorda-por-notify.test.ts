/**
 * O BANCO AVISA O WORKER (migration 1000).
 *
 * Os gatilhos por comando de `event_log` e `job_queue` fazem `pg_notify`, e o
 * ouvinte do worker (`lib/agent-engine/ouvinte-do-banco.ts`) é quem os escuta.
 * Aqui a prova é a do lado do banco, com uma conexão de verdade fazendo LISTEN
 * no Postgres que o `baseline.sql` montou:
 *
 *   - INSERT em `event_log` notifica `hb_event_log` com os tipos DISTINTOS do
 *     comando — um lote vira UMA notificação;
 *   - INSERT em `job_queue` notifica `hb_job_queue`;
 *   - UPDATE que devolve job a `pending` (retry, reagendamento, reaper)
 *     notifica; o claim (`pending` → `running`) não;
 *   - ROLLBACK não notifica — NOTIFY é transacional, nunca efeito colateral
 *     fora do commit;
 *   - as funções de gatilho não são executáveis por anon nem authenticated e não
 *     são `security definer`.
 *
 * As notificações de OUTROS testes rodando no mesmo banco também chegam a esta
 * conexão: por isso cada caso procura o PRÓPRIO tipo de evento (sufixo
 * aleatório) e, para a `job_queue`, mede dentro de uma janela em que só ele
 * escreve na organização que criou — e confere a AUSÊNCIA só com tipo próprio.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;

const ouvinte = new pg.Client({ connectionString: URL });
const escritor = new pg.Client({ connectionString: URL });
const recebidas: { canal: string; payload: string; em: number }[] = [];
const org = randomUUID();
const sufixo = randomUUID().replace(/[^a-f]/g, '').slice(0, 8) || 'abc';

beforeAll(async () => {
  await ouvinte.connect();
  await escritor.connect();
  ouvinte.on('notification', (n) =>
    recebidas.push({ canal: n.channel, payload: n.payload ?? '', em: Date.now() }),
  );
  await ouvinte.query('listen hb_event_log');
  await ouvinte.query('listen hb_job_queue');
  await escritor.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Ouvinte','Ouvinte')",
    [org],
  );
});

afterAll(async () => {
  await escritor.query('delete from organizations where id = $1', [org]).catch(() => undefined);
  await ouvinte.end();
  await escritor.end();
});

/** Espera até `ms` alguma notificação que satisfaça `cond`. */
async function esperar(
  cond: (r: { canal: string; payload: string }) => boolean,
  ms = 3_000,
): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (recebidas.some(cond)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return recebidas.some(cond);
}

function tipo(nome: string): string {
  return `teste_ouvinte.${nome}_${sufixo}`;
}

async function inserirEventos(tipos: string[]): Promise<void> {
  await escritor.query(
    `insert into event_log(organization_id, event_type, entity_kind)
       select $1::uuid, t, 'teste' from unnest($2::text[]) as t`,
    [org, tipos],
  );
}

describe('event_log notifica hb_event_log', () => {
  it('um INSERT notifica com o tipo inserido', async () => {
    await inserirEventos([tipo('um')]);
    expect(await esperar((r) => r.canal === 'hb_event_log' && r.payload.split(',').includes(tipo('um')))).toBe(true);
  });

  it('um lote vira UMA notificação, com os tipos distintos', async () => {
    const a = tipo('lote_a');
    const b = tipo('lote_b');
    await inserirEventos([a, a, a, b, b]);
    expect(await esperar((r) => r.canal === 'hb_event_log' && r.payload.includes(a))).toBe(true);
    const doLote = recebidas.filter((r) => r.canal === 'hb_event_log' && r.payload.includes(a));
    expect(doLote).toHaveLength(1);
    expect(doLote[0]!.payload.split(',').sort()).toEqual([a, b].sort());
  });

  it('ROLLBACK não notifica', async () => {
    const t = tipo('desfeito');
    await escritor.query('begin');
    await inserirEventos([t]);
    await escritor.query('rollback');
    // Um commit DEPOIS, para provar que a conexão está viva e entregando.
    await inserirEventos([tipo('depois_do_rollback')]);
    expect(await esperar((r) => r.payload.includes(tipo('depois_do_rollback')))).toBe(true);
    expect(recebidas.some((r) => r.payload.includes(t))).toBe(false);
  });
});

describe('job_queue notifica hb_job_queue', () => {
  async function contagemNoIntervalo(acao: () => Promise<void>): Promise<number> {
    // Silêncio antes: o que outro teste notificou até aqui não entra na conta.
    await new Promise((r) => setTimeout(r, 150));
    const desde = Date.now();
    await acao();
    await new Promise((r) => setTimeout(r, 400));
    return recebidas.filter((r) => r.canal === 'hb_job_queue' && r.em >= desde).length;
  }

  it('INSERT notifica', async () => {
    const n = await contagemNoIntervalo(async () => {
      await escritor.query("insert into job_queue(organization_id, kind) values($1, 'watchdog')", [org]);
    });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('UPDATE que devolve a pending (o retry) notifica', async () => {
    const { rows } = await escritor.query<{ id: string }>(
      "insert into job_queue(organization_id, kind, status) values($1, 'watchdog', 'running') returning id",
      [org],
    );
    const id = rows[0]!.id;
    const n = await contagemNoIntervalo(async () => {
      await escritor.query(
        "update job_queue set status = 'pending', run_after = now() + interval '1 minute' where id = $1",
        [id],
      );
    });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('o gatilho de UPDATE só notifica quando alguma linha fica pending (o claim não)', async () => {
    // Complemento: a regra no catálogo, pelo corpo da função que o banco instalou.
    // A prova de comportamento (contagem de notificações) vem logo abaixo.
    const { rows } = await escritor.query<{ def: string }>(
      `select pg_get_functiondef('public.fn_job_queue_notifica_worker()'::regprocedure) as def`,
    );
    expect(rows[0]!.def).toMatch(/tg_op\s*=\s*'UPDATE'/);
    expect(rows[0]!.def).toMatch(/n\.status\s*=\s*'pending'/);

    // E a prova é a CONTAGEM de notificações na conexão LISTEN, em janelas de
    // silêncio: INSERT notifica; o claim (`pending` -> `running`) não; devolver
    // a `pending` (o retry) notifica uma vez.
    const JANELA_MS = 700;
    const contar = async (acao: () => Promise<void>): Promise<number> => {
      // Silêncio antes: o que o INSERT acabou de notificar tem de ter chegado.
      await new Promise((r) => setTimeout(r, 300));
      const desde = Date.now();
      await acao();
      await new Promise((r) => setTimeout(r, JANELA_MS));
      return recebidas.filter((r) => r.canal === 'hb_job_queue' && r.em >= desde).length;
    };

    let id = '';
    const nInsert = await contar(async () => {
      const { rows: job } = await escritor.query<{ id: string }>(
        "insert into job_queue(organization_id, kind) values($1, 'watchdog') returning id",
        [org],
      );
      id = job[0]!.id;
    });
    expect(nInsert).toBeGreaterThanOrEqual(1);

    const nClaim = await contar(async () => {
      await escritor.query("update job_queue set status = 'running', locked_by = 'teste' where id = $1", [id]);
    });
    expect(nClaim).toBe(0);

    const nRetry = await contar(async () => {
      await escritor.query(
        "update job_queue set status = 'pending', locked_by = null, run_after = now() + interval '1 minute' where id = $1",
        [id],
      );
    });
    expect(nRetry).toBe(1);
  });
});

describe('os gatilhos e as funções', () => {
  it('existem, são por COMANDO e AFTER', async () => {
    const { rows } = await escritor.query<{ tgname: string; tabela: string; tgtype: number }>(
      `select t.tgname, c.relname as tabela, t.tgtype
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where t.tgname in ('trg_event_log_notifica_worker','trg_job_queue_notifica_worker','trg_job_queue_notifica_worker_update')
        order by 1`,
    );
    expect(rows.map((r) => `${r.tabela}.${r.tgname}`)).toEqual([
      'event_log.trg_event_log_notifica_worker',
      'job_queue.trg_job_queue_notifica_worker',
      'job_queue.trg_job_queue_notifica_worker_update',
    ]);
    for (const r of rows) {
      // bit 0 = ROW, bit 1 = BEFORE: os dois têm de estar desligados.
      expect(r.tgtype & 1, `${r.tgname} é por linha`).toBe(0);
      expect(r.tgtype & 2, `${r.tgname} é BEFORE`).toBe(0);
    }
  });

  it('não são security definer e não são executáveis por anon nem authenticated', async () => {
    const { rows } = await escritor.query<{ proname: string; prosecdef: boolean; anon: boolean; auth: boolean }>(
      `select p.proname, p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('fn_event_log_notifica_worker','fn_job_queue_notifica_worker')
        order by 1`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: false, anon: false, auth: false });
    }
  });

  it('quem escreve SEM EXECUTE na função de gatilho continua inserindo e notificando', async () => {
    // O EXECUTE de função de gatilho só é conferido no CREATE TRIGGER. Se isso
    // mudasse, o revoke acima quebraria toda escrita do app — por isso a prova
    // usa um papel que comprovadamente NÃO tem o privilégio.
    const papel = `teste_ouvinte_${sufixo}`;
    const t = tipo('sem_execute');
    await escritor.query(`create role ${papel} nologin bypassrls`);
    try {
      await escritor.query(`grant usage on schema public to ${papel}`);
      await escritor.query(`grant insert on public.event_log to ${papel}`);
      // Os outros gatilhos BEFORE do event_log chamam funções auxiliares por
      // chamada comum, e essa exige EXECUTE: o papel ganha todas, menos a nossa.
      await escritor.query(`grant execute on all functions in schema public to ${papel}`);
      await escritor.query(`revoke execute on function public.fn_event_log_notifica_worker() from ${papel}`);
      const { rows } = await escritor.query<{ pode: boolean }>(
        `select has_function_privilege($1, 'public.fn_event_log_notifica_worker()', 'execute') as pode`,
        [papel],
      );
      expect(rows[0]!.pode).toBe(false);
      await escritor.query('begin');
      await escritor.query(`set local role ${papel}`);
      await escritor.query(
        "insert into public.event_log(organization_id, event_type, entity_kind) values($1, $2, 'teste')",
        [org, t],
      );
      await escritor.query('commit');
      expect(await esperar((r) => r.payload.includes(t))).toBe(true);
    } finally {
      await escritor.query('rollback').catch(() => undefined);
      await escritor.query(`drop owned by ${papel}`).catch(() => undefined);
      await escritor.query(`drop role if exists ${papel}`).catch(() => undefined);
    }
  });
});

describe('calendar_appointments fora da publicação supabase_realtime', () => {
  it('a publicação existe e não contém a agenda', async () => {
    const { rows } = await escritor.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.map((r) => r.tablename)).not.toContain('calendar_appointments');
  });
});
