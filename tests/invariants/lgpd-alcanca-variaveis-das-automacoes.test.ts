// @vitest-environment node
import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * LGPD — a anonimização alcança as VARIÁVEIS das automações (migration 1006).
 *
 * As automações guardam dado da pessoa em `followup_enrollments.vars` (0986):
 * a resposta do bloco Pergunta (`resposta.*`), o que o bloco HTTP devolveu
 * (`saida.*`), o `gatilho.*` e o `param.*`. Sob prova, no banco que o clone
 * recebe (baseline aplicado por `scripts/test-db.sh`):
 *
 *  1. a virada de `is_anonymized` zera `vars` de TODAS as execuções do contato
 *     (as duas raias) e cancela a automação viva — e o vizinho da mesma
 *     organização e o contato da OUTRA organização ficam intactos;
 *  2. a trilha (`followup_enrollment_events`) fica legível sem a pessoa: o
 *     evento não guarda resposta nem saída, então nada some dele (node_id,
 *     event_type e data preservados);
 *  3. ⭐ a corrida: com a anonimização EM VOO (segurando a trava do contato,
 *     como os dois caminhos fazem), `fn_automacao_iniciar` espera a trava e
 *     recusa (`contato_invalido`) — antes da 1006 ela lia `is_anonymized`
 *     antes da trava e nascia uma execução viva, com `gatilho.*` nas
 *     variáveis, DEPOIS de a limpeza ter passado.
 *
 * Namespace `1006aaaa-…`: os arquivos de invariante rodam em paralelo contra o
 * MESMO container. Dados sintéticos.
 */

const CONTAINER = process.env.TEST_DB_CONTAINER;
if (!CONTAINER) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:invariants` (scripts/test-db.sh)",
  );
}

const ORG_A = "1006aaaa-0000-4000-8000-000000000001";
const ORG_B = "1006aaaa-0000-4000-8000-000000000002";
const ALVO = "1006aaaa-3333-4000-8000-000000000001";
const VIZINHO = "1006aaaa-3333-4000-8000-000000000002";
const OUTRA_ORG = "1006aaaa-3333-4000-8000-000000000003";
const CORRIDA = "1006aaaa-3333-4000-8000-000000000004";
const V_AUTO_A = "1006aaaa-5555-4000-8000-000000000001";
const V_FOLLOW_A = "1006aaaa-5555-4000-8000-000000000002";
const V_AUTO_B = "1006aaaa-5555-4000-8000-000000000003";
const P_AUTO_A = "1006aaaa-6666-4000-8000-000000000001";
const P_FOLLOW_A = "1006aaaa-6666-4000-8000-000000000002";
const P_AUTO_B = "1006aaaa-6666-4000-8000-000000000003";
const E_ALVO_AUTO = "1006aaaa-7777-4000-8000-000000000001";
const E_ALVO_FOLLOW = "1006aaaa-7777-4000-8000-000000000002";
const E_VIZINHO = "1006aaaa-7777-4000-8000-000000000003";
const E_OUTRA_ORG = "1006aaaa-7777-4000-8000-000000000004";

/** Dado de pessoa nas variáveis: resposta, saída HTTP, gatilho e parâmetro. */
const VARS = JSON.stringify({
  resposta: { question_1: "Maria Sintética da Silva", question_2: "+5511999990000" },
  saida: { telefone: "+5511988887777", nome_no_erp: "Maria S." },
  gatilho: { tipo: "manual", nome: "Maria" },
  param: { observacao: "cliente pediu retorno" },
  _lead_id: "1006aaaa-8888-4000-8000-000000000001",
});

const GRAFO = JSON.stringify({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: { x: 0, y: 0 },
      config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
});

const GRAFO_FOLLOW = JSON.stringify({
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
});

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sessão psql assíncrona, para a corrida (mesmo desenho de conversa-que-nasce-durante-a-trava-do-contato). */
function psqlAssincrono(script: string): Promise<{ saida: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn(
      "docker",
      ["exec", "-i", CONTAINER as string, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d: Buffer) => (saida += d.toString()));
    p.stderr.on("data", (d: Buffer) => (erro += d.toString()));
    p.on("close", (codigo) => {
      if (codigo === 0) resolve({ saida: saida.trim(), ms: Date.now() - t0 });
      else reject(new Error(`psql falhou (${codigo}): ${erro}`));
    });
    p.stdin.end(script);
  });
}

function enrollment(id: string, org: string, pointer: string, versao: string, contato: string): string {
  return `insert into public.followup_enrollments
      (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, vars)
    values ('${id}', '${org}', '${pointer}', '${versao}', '${contato}', 't', 'active', '${VARS}'::jsonb);`;
}

function evento(enrollmentId: string, org: string): string {
  // A forma real do `effect_done` de um bloco HTTP: só os NOMES das saídas.
  const payload = JSON.stringify({
    desfecho: { ok: true },
    vars: { _lead_id: "1006aaaa-8888-4000-8000-000000000001" },
    detalhes: [{ tipo: "http_request", metodo: "GET", host: "api.exemplo.test", campos: ["telefone", "nome_no_erp"], ok: true }],
  });
  return `insert into public.followup_enrollment_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    values ('${org}', '${enrollmentId}', 'http-1', 'effect_done', '${payload}'::jsonb, 'http-1:0:efeito_fim');`;
}

const varsDe = (id: string) => lastLine(sql(`select vars::text from public.followup_enrollments where id = '${id}';`));
const statusDe = (id: string) => lastLine(sql(`select status from public.followup_enrollments where id = '${id}';`));
const trilhaDe = (id: string) =>
  lastLine(
    sql(`select coalesce(string_agg(node_id || '|' || event_type || '|' || created_at::text || '|' || payload::text, ';' order by created_at, id), '')
           from public.followup_enrollment_events where enrollment_id = '${id}';`),
  );

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-1006-a', 'Inv 1006 A', 'Inv 1006 A'),
      ('${ORG_B}', 'inv-1006-b', 'Inv 1006 B', 'Inv 1006 B')
      on conflict do nothing;
    delete from public.followup_enrollments where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.contacts where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.contacts (id, organization_id, display_name) values
      ('${ALVO}', '${ORG_A}', 'Alvo 1006'),
      ('${VIZINHO}', '${ORG_A}', 'Vizinho 1006'),
      ('${CORRIDA}', '${ORG_A}', 'Corrida 1006'),
      ('${OUTRA_ORG}', '${ORG_B}', 'Outra org 1006');
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${V_AUTO_A}', '${ORG_A}', '${GRAFO}'::jsonb),
      ('${V_FOLLOW_A}', '${ORG_A}', '${GRAFO_FOLLOW}'::jsonb),
      ('${V_AUTO_B}', '${ORG_B}', '${GRAFO}'::jsonb)
      on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${P_AUTO_A}', '${ORG_A}', 'Auto A 1006', 'active', '${V_AUTO_A}', 'automacao'),
      ('${P_FOLLOW_A}', '${ORG_A}', 'Follow A 1006', 'active', '${V_FOLLOW_A}', 'followup'),
      ('${P_AUTO_B}', '${ORG_B}', 'Auto B 1006', 'active', '${V_AUTO_B}', 'automacao')
      on conflict do nothing;
    ${enrollment(E_ALVO_AUTO, ORG_A, P_AUTO_A, V_AUTO_A, ALVO)}
    ${enrollment(E_ALVO_FOLLOW, ORG_A, P_FOLLOW_A, V_FOLLOW_A, ALVO)}
    ${enrollment(E_VIZINHO, ORG_A, P_AUTO_A, V_AUTO_A, VIZINHO)}
    ${enrollment(E_OUTRA_ORG, ORG_B, P_AUTO_B, V_AUTO_B, OUTRA_ORG)}
    ${evento(E_ALVO_AUTO, ORG_A)}
    ${evento(E_VIZINHO, ORG_A)}
  `);
});

describe("1006 — a anonimização alcança as variáveis das automações", () => {
  it("a virada zera vars do contato nas duas raias, cancela a automação viva e não toca vizinho nem outra organização", () => {
    // Controle positivo: o dado está lá antes.
    for (const id of [E_ALVO_AUTO, E_ALVO_FOLLOW, E_VIZINHO, E_OUTRA_ORG]) {
      expect(varsDe(id)).toContain("Maria Sintética da Silva");
    }
    const trilhaAntes = trilhaDe(E_ALVO_AUTO);
    expect(trilhaAntes).toContain("http-1|effect_done|");

    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${ALVO}';`);

    expect(varsDe(E_ALVO_AUTO), "as variáveis da automação do titular sobreviveram à anonimização").toBe("{}");
    expect(varsDe(E_ALVO_FOLLOW), "as variáveis do follow-up do titular sobreviveram à anonimização").toBe("{}");
    expect(statusDe(E_ALVO_AUTO), "a automação viva do titular seguiu rodando depois da anonimização").toBe("cancelled");
    expect(lastLine(sql(`select cancel_reason from public.followup_enrollments where id = '${E_ALVO_AUTO}';`))).toBe(
      "Contato anonimizado (LGPD)",
    );

    // A trilha fica: o evento não guardava a pessoa, e nada dele some.
    const trilhaDepois = trilhaDe(E_ALVO_AUTO);
    expect(trilhaDepois).toBe(trilhaAntes);
    expect(trilhaDepois).not.toMatch(/Maria|\+5511/);

    // Vizinho da mesma organização e contato da outra organização: intactos.
    expect(varsDe(E_VIZINHO)).toContain("+5511988887777");
    expect(statusDe(E_VIZINHO)).toBe("active");
    expect(varsDe(E_OUTRA_ORG)).toContain("Maria Sintética da Silva");
    expect(statusDe(E_OUTRA_ORG)).toBe("active");
  });

  it("⭐ com a anonimização em voo, fn_automacao_iniciar espera a trava e não nasce execução para o titular", async () => {
    // A anonimização como os dois caminhos fazem: toma a trava do contato,
    // vira is_anonymized e só confirma depois (2 s).
    const anonimizando = psqlAssincrono(
      `begin;
       select public.fn_service_lock('${ORG_A}', '${CORRIDA}');
       update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${CORRIDA}';
       select pg_sleep(2);
       commit;`,
    );
    await dormir(600); // a trava já está tomada e a virada já rodou, sem commit

    const iniciando = await psqlAssincrono(
      `select public.fn_automacao_iniciar('${ORG_A}', '${P_AUTO_A}', '${CORRIDA}',
         '{"gatilho":{"tipo":"manual","nome":"Joana Sintética"}}'::jsonb, null, null)::text;`,
    );
    await anonimizando;

    expect(iniciando.ms, "a RPC não esperou a trava do contato — a corrida não foi exercitada").toBeGreaterThan(900);
    expect(JSON.parse(iniciando.saida.split("\n").at(-1)!).resultado).toBe("contato_invalido");
    expect(
      lastLine(
        sql(`select count(*) from public.followup_enrollments
              where organization_id = '${ORG_A}' and contact_id = '${CORRIDA}';`),
      ),
      "nasceu execução (com gatilho.* nas variáveis) para contato anonimizado: a releitura sob a trava sumiu",
    ).toBe("0");
  });
});
