import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTOMACAO_GATILHOS_HANDLER_KEY } from "@/lib/automacoes/chaves";
import { decisaoDoGatilhoDeMensagem } from "@/lib/automacoes/uma-voz";

import { sql } from "./gov-helpers";

/**
 * UMA VOZ NO INÍCIO, com o SQL real de `decisaoDoGatilhoDeMensagem` no banco
 * que o clone recebe (baseline aplicado por `scripts/test-db.sh`). A linha
 * `message.received` nasce do gatilho do banco (`fn_emit_message_event`) ao
 * inserir a mensagem — nada é fabricado no `event_log`.
 *
 * Sob prova:
 *  1. evento ainda não consumido + automação armada cuja palavra-chave casa → `esperar`;
 *     palavra-chave que não casa → `seguir`;
 *  2. consumido + execução nascida dele, viva → `ceder`; terminada sem falar →
 *     `seguir`; terminada depois de falar na conversa → `ceder`;
 *  3. isolamento: a mesma mensagem perguntada por OUTRA organização → `seguir`,
 *     e a automação armada da outra organização não faz esperar.
 *
 * Namespace `0999eeee-…` (os arquivos de invariante rodam em paralelo).
 */
const ORG = "0999eeee-0000-4000-8000-000000000001";
const VIZ = "0999eeee-0000-4000-8000-000000000002";
const SESSAO = "0999eeee-1111-4000-8000-000000000001";
const SESSAO_VIZ = "0999eeee-1111-4000-8000-000000000002";
const CONTATO = "0999eeee-3333-4000-8000-000000000001";
const CONTATO_VIZ = "0999eeee-3333-4000-8000-000000000002";
const CONV = "0999eeee-4444-4000-8000-000000000001";
const CONV_VIZ = "0999eeee-4444-4000-8000-000000000002";
const VERSAO = "0999eeee-5555-4000-8000-000000000001";
const VERSAO_VIZ = "0999eeee-5555-4000-8000-000000000002";
const PONTEIRO = "0999eeee-6666-4000-8000-000000000001";
const PONTEIRO_VIZ = "0999eeee-6666-4000-8000-000000000002";
const MSG_PRECO = "0999eeee-7777-4000-8000-000000000001";
const MSG_BOLETO = "0999eeee-7777-4000-8000-000000000002";
const MSG_VIZ = "0999eeee-7777-4000-8000-000000000003";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

function grafo(palavra: string): string {
  return JSON.stringify({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: {
          triggers: [{ kind: "message_received", match: "contains", keywords: [palavra] }],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      { id: "m", type: "message", label: "Oi", position: { x: 0, y: 100 }, config: {} },
      { id: "f", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
    ],
    edges: [],
  });
}

function eventoDa(mensagem: string): string {
  return sql(
    `select id from public.event_log where organization_id='${ORG}' and event_type='message.received' and entity_id='${mensagem}';`,
  )
    .split("\n")
    .at(-1)!
    .trim();
}

const decidir = (org: string, messageId: string) =>
  decisaoDoGatilhoDeMensagem(pool, { organizationId: org, messageId });

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-uma-voz-a', 'Inv uma voz A', 'Inv uma voz A'),
      ('${VIZ}', 'inv-uma-voz-b', 'Inv uma voz B', 'Inv uma voz B') on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSAO}', '${ORG}', 'inv-uma-voz-a', '\\x00'::bytea),
      ('${SESSAO_VIZ}', '${VIZ}', 'inv-uma-voz-b', '\\x00'::bytea) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO}', '${ORG}', 'Contato uma voz'),
      ('${CONTATO_VIZ}', '${VIZ}', 'Contato vizinho') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open'),
      ('${CONV_VIZ}', '${VIZ}', '${CONTATO_VIZ}', '${SESSAO_VIZ}', 'open') on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${VERSAO}', '${ORG}', '${grafo("preço")}'::jsonb),
      ('${VERSAO_VIZ}', '${VIZ}', '${grafo("boleto")}'::jsonb) on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${PONTEIRO}', '${ORG}', 'Preço uma voz', 'active', '${VERSAO}', 'automacao'),
      ('${PONTEIRO_VIZ}', '${VIZ}', 'Boleto vizinho', 'active', '${VERSAO_VIZ}', 'automacao') on conflict do nothing;
    delete from public.followup_enrollments where organization_id in ('${ORG}', '${VIZ}');
    delete from public.messages where organization_id in ('${ORG}', '${VIZ}');
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body) values
      ('${MSG_PRECO}', '${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}', 'text', 'inbound', 'received', 'Qual o PRECO?'),
      ('${MSG_BOLETO}', '${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}', 'text', 'inbound', 'received', 'manda o boleto'),
      ('${MSG_VIZ}', '${VIZ}', '${CONV_VIZ}', '${SESSAO_VIZ}', '${CONTATO_VIZ}', 'text', 'inbound', 'received', 'qual o preço');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("uma voz no início — o SQL de decisaoDoGatilhoDeMensagem", () => {
  it("evento pendente: espera só se a palavra-chave da automação armada casa", async () => {
    expect(eventoDa(MSG_PRECO)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await decidir(ORG, MSG_PRECO)).toBe("esperar");
    expect(await decidir(ORG, MSG_BOLETO)).toBe("seguir");
  });

  it("isolamento: outra organização não vê o evento, e a automação dela ('boleto') não casa a mensagem dela", async () => {
    expect(await decidir(VIZ, MSG_PRECO)).toBe("seguir");
    expect(await decidir(VIZ, MSG_VIZ)).toBe("seguir");
  });

  it("consumido: cede com a execução viva; segue se terminou sem falar; cede se terminou depois de falar", async () => {
    const ev = eventoDa(MSG_PRECO);
    sql(`update public.event_log set consumed_by = array_append(coalesce(consumed_by, '{}'), '${AUTOMACAO_GATILHOS_HANDLER_KEY}')
         where id = '${ev}';`);
    const execucao = sql(`insert into public.followup_enrollments
        (organization_id, pointer_id, version_id, contact_id, current_node_id, status, lane, origin_event_id)
        values ('${ORG}', '${PONTEIRO}', '${VERSAO}', '${CONTATO}', 'm', 'active', 'automacao', '${ev}') returning id;`)
      .split("\n")
      .find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))!
      .trim();
    expect(await decidir(ORG, MSG_PRECO)).toBe("ceder");
    // Uma execução de OUTRA organização com a mesma origem não cala a IA desta.
    expect(await decidir(VIZ, MSG_PRECO)).toBe("seguir");

    sql(`update public.followup_enrollments set status='completed', completed_at=now() where id='${execucao}';`);
    expect(await decidir(ORG, MSG_PRECO)).toBe("seguir");

    sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, metadata)
         values ('${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}', 'text', 'outbound', 'sent', 'Olá!',
                 jsonb_build_object('origem_automacao', jsonb_build_object('enrollment_id', '${execucao}', 'pointer_id', '${PONTEIRO}')));`);
    expect(await decidir(ORG, MSG_PRECO)).toBe("ceder");
  });
});
