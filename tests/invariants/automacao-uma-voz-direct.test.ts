import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { automacaoEsperaRespostaNaConversa } from "@/lib/automacoes/uma-voz";

import { sql } from "./gov-helpers";

/**
 * UMA VOZ NO DIRECT, com o SQL real de `automacaoEsperaRespostaNaConversa` (o
 * que o drain do agente pergunta antes de responder) no banco que o clone
 * recebe (baseline aplicado por `scripts/test-db.sh`).
 *
 * A execução que começou por um comentário do Instagram não tem envio na
 * conversa do Direct (a resposta privada não vira linha de `messages`); quem
 * liga a conversa à execução é `vars.gatilho` — mesma conexão
 * (`channel_session_id`) e mesmo IGSID (`provider_conversation_id`).
 *
 * Sob prova:
 *  1. execução em `waiting_reply` → a IA cede na conversa do Direct desse IGSID
 *     nessa conexão;
 *  2. não cede numa conversa de OUTRO IGSID, nem numa de OUTRA conexão com o
 *     mesmo IGSID;
 *  3. isolamento: outra organização perguntando pela mesma conversa → não cede;
 *     e uma execução de outra organização que aponta para a mesma conexão e o
 *     mesmo IGSID não cala a IA desta;
 *  4. execução terminada → não cede.
 *
 * Namespace `0998dddd-…` (os arquivos de invariante rodam em paralelo).
 */
const ORG = "0998dddd-0000-4000-8000-000000000001";
const VIZ = "0998dddd-0000-4000-8000-000000000002";
const SESSAO = "0998dddd-1111-4000-8000-000000000001";
const SESSAO_2 = "0998dddd-1111-4000-8000-000000000002";
const SESSAO_VIZ = "0998dddd-1111-4000-8000-000000000003";
const CONTATO = "0998dddd-3333-4000-8000-000000000001";
const CONTATO_B = "0998dddd-3333-4000-8000-000000000002";
const CONTATO_VIZ = "0998dddd-3333-4000-8000-000000000003";
const CONV_DIRECT = "0998dddd-4444-4000-8000-000000000001";
const CONV_OUTRO_IGSID = "0998dddd-4444-4000-8000-000000000002";
const CONV_OUTRA_CONEXAO = "0998dddd-4444-4000-8000-000000000003";
const CONV_VIZ = "0998dddd-4444-4000-8000-000000000004";
const VERSAO = "0998dddd-5555-4000-8000-000000000001";
const VERSAO_VIZ = "0998dddd-5555-4000-8000-000000000002";
const PONTEIRO = "0998dddd-6666-4000-8000-000000000001";
const PONTEIRO_VIZ = "0998dddd-6666-4000-8000-000000000002";
const EXEC = "0998dddd-7777-4000-8000-000000000001";
const EXEC_VIZ = "0998dddd-7777-4000-8000-000000000002";
const IGSID = "6543210987654321";
const IGSID_B = "1234567890123456";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const GRAFO = JSON.stringify({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: { x: 0, y: 0 },
      config: { triggers: [{ kind: "instagram_comment" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
    { id: "w", type: "wait", label: "Aguardar", position: { x: 0, y: 100 }, config: { mode: "until_reply" } },
  ],
  edges: [],
});

function varsDoComentario(sessao: string, igsid: string): string {
  return JSON.stringify({
    gatilho: { tipo: "instagram_comment", comment_id: "17890000000000001", channel_session_id: sessao, autor_id: igsid },
  });
}

const cede = (org: string, conversationId: string) =>
  automacaoEsperaRespostaNaConversa(pool, { organizationId: org, conversationId });

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-uma-voz-direct-a', 'Inv uma voz Direct A', 'Inv uma voz Direct A'),
      ('${VIZ}', 'inv-uma-voz-direct-b', 'Inv uma voz Direct B', 'Inv uma voz Direct B') on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, provider, meta_social_platform, meta_social_account_id, webhook_secret_encrypted) values
      ('${SESSAO}', '${ORG}', 'meta_social', 'instagram', 'IG-0998-A', '\\x00'::bytea),
      ('${SESSAO_2}', '${ORG}', 'meta_social', 'instagram', 'IG-0998-A2', '\\x00'::bytea),
      ('${SESSAO_VIZ}', '${VIZ}', 'meta_social', 'instagram', 'IG-0998-B', '\\x00'::bytea) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO}', '${ORG}', 'Quem comentou'),
      ('${CONTATO_B}', '${ORG}', 'Outra pessoa'),
      ('${CONTATO_VIZ}', '${VIZ}', 'Contato vizinho') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, provider_conversation_id, status) values
      ('${CONV_DIRECT}', '${ORG}', '${CONTATO}', '${SESSAO}', '${IGSID}', 'open'),
      ('${CONV_OUTRO_IGSID}', '${ORG}', '${CONTATO_B}', '${SESSAO}', '${IGSID_B}', 'open'),
      ('${CONV_OUTRA_CONEXAO}', '${ORG}', '${CONTATO}', '${SESSAO_2}', '${IGSID}', 'open'),
      ('${CONV_VIZ}', '${VIZ}', '${CONTATO_VIZ}', '${SESSAO_VIZ}', '${IGSID}', 'open') on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${VERSAO}', '${ORG}', '${GRAFO}'::jsonb),
      ('${VERSAO_VIZ}', '${VIZ}', '${GRAFO}'::jsonb) on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${PONTEIRO}', '${ORG}', 'Comentário uma voz', 'active', '${VERSAO}', 'automacao'),
      ('${PONTEIRO_VIZ}', '${VIZ}', 'Comentário vizinho', 'active', '${VERSAO_VIZ}', 'automacao') on conflict do nothing;
    delete from public.followup_enrollments where organization_id in ('${ORG}', '${VIZ}');
    delete from public.messages where organization_id in ('${ORG}', '${VIZ}');
    insert into public.followup_enrollments
      (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, lane, vars) values
      ('${EXEC}', '${ORG}', '${PONTEIRO}', '${VERSAO}', '${CONTATO}', 'w', 'waiting_reply', 'automacao',
        '${varsDoComentario(SESSAO, IGSID)}'::jsonb);
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("uma voz no Direct — o SQL de automacaoEsperaRespostaNaConversa", () => {
  it("execução esperando: cede na conversa do Direct desse IGSID nessa conexão", async () => {
    expect(await cede(ORG, CONV_DIRECT)).toBe(true);
  });

  it("não cede para outro IGSID nem para outra conexão com o mesmo IGSID", async () => {
    expect(await cede(ORG, CONV_OUTRO_IGSID)).toBe(false);
    expect(await cede(ORG, CONV_OUTRA_CONEXAO)).toBe(false);
  });

  it("isolamento: outra organização perguntando pela mesma conversa não vê a execução", async () => {
    expect(await cede(VIZ, CONV_DIRECT)).toBe(false);
    expect(await cede(VIZ, CONV_VIZ)).toBe(false);
  });

  it("execução terminada não cala a IA — nem uma execução de outra organização que aponta para a mesma conexão e IGSID", async () => {
    sql(`
      insert into public.followup_enrollments
        (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, lane, vars) values
        ('${EXEC_VIZ}', '${VIZ}', '${PONTEIRO_VIZ}', '${VERSAO_VIZ}', '${CONTATO_VIZ}', 'w', 'waiting_reply', 'automacao',
          '${varsDoComentario(SESSAO, IGSID)}'::jsonb);
      update public.followup_enrollments set status = 'completed', completed_at = now() where id = '${EXEC}';
    `);
    expect(await cede(ORG, CONV_DIRECT)).toBe(false);
  });
});
