import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A mesma pessoa comenta DUAS vezes (mesmo IGSID, dois comentários) numa
 * automação por comentário com reentrada `skip_if_running`: a segunda chamada
 * de `fn_automacao_iniciar` (a RPC real, no baseline que o clone recebe) não
 * abre outra execução — `ja_em_execucao` —, e por isso o bloco "Responder em
 * privado" e o resto do fluxo rodam UMA vez: a pessoa não recebe em dobro.
 *
 * O contato é o mesmo nas duas: o handler dos gatilhos acha o comentarista pela
 * `social_identity` (`instagram:<conta>:<IGSID>`), a mesma da primeira vez.
 *
 * Namespace `0997cccc-…` (os arquivos de invariante rodam em paralelo).
 */
const ORG = "0997cccc-0000-4000-8000-000000000001";
const SESSAO = "0997cccc-1111-4000-8000-000000000001";
const CONTATO = "0997cccc-3333-4000-8000-000000000001";
const VERSAO = "0997cccc-5555-4000-8000-000000000001";
const PONTEIRO = "0997cccc-6666-4000-8000-000000000001";
const IGSID = "6543210987654321";

const GRAFO = JSON.stringify({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: { x: 0, y: 0 },
      config: {
        triggers: [{ kind: "instagram_comment", match: "any", keywords: [] }],
        reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
      },
    },
    {
      id: "priv",
      type: "instagram_private_reply",
      label: "Privada",
      position: { x: 0, y: 100 },
      config: { text: "Responda QUERO" },
    },
    {
      id: "w",
      type: "wait",
      label: "Aguardar",
      position: { x: 0, y: 200 },
      config: { mode: "until_reply", timeout_ms: 86400000 },
    },
  ],
  edges: [
    { id: "e1", source: "t", target: "priv", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "priv", target: "w", priority: 0, condition: { type: "always" } },
  ],
});

function iniciarPorComentario(commentId: string): { resultado: string; enrollment_id?: string } {
  const vars = JSON.stringify({
    gatilho: {
      tipo: "instagram_comment",
      comment_id: commentId,
      channel_session_id: SESSAO,
      autor_id: IGSID,
    },
  });
  const out = sql(
    `select public.fn_automacao_iniciar('${ORG}', '${PONTEIRO}', '${CONTATO}', '${vars}'::jsonb, null, null)::text;`,
  );
  return JSON.parse(out.split("\n").at(-1)!);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-coment-reentrada', 'Inv comentário reentrada', 'Inv comentário reentrada') on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, provider, meta_social_platform, meta_social_account_id, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'meta_social', 'instagram', 'IG-0997', '\\x00'::bytea) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, social_identity)
      values ('${CONTATO}', '${ORG}', 'Quem comentou', 'instagram:IG-0997:${IGSID}') on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph)
      values ('${VERSAO}', '${ORG}', '${GRAFO}'::jsonb) on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface)
      values ('${PONTEIRO}', '${ORG}', 'Comentário reentrada', 'active', '${VERSAO}', 'automacao') on conflict do nothing;
    delete from public.followup_enrollments where organization_id = '${ORG}';
  `);
});

describe("comentou duas vezes, skip_if_running", () => {
  it("o 1º comentário inicia; o 2º devolve ja_em_execucao e não abre outra execução", () => {
    const primeira = iniciarPorComentario("17890000000000001");
    expect(primeira.resultado).toBe("iniciada");
    const segunda = iniciarPorComentario("17890000000000002");
    expect(segunda.resultado).toBe("ja_em_execucao");
    expect(segunda.enrollment_id).toBe(primeira.enrollment_id);

    const vivas = sql(`select count(*) from public.followup_enrollments
      where organization_id = '${ORG}' and pointer_id = '${PONTEIRO}';`);
    expect(vivas.split("\n").at(-1)).toBe("1");
    // A execução que segue é a do 1º comentário: é a resposta privada DELE que sai, uma vez.
    const comentario = sql(`select vars->'gatilho'->>'comment_id' from public.followup_enrollments
      where id = '${primeira.enrollment_id}';`);
    expect(comentario.split("\n").at(-1)).toBe("17890000000000001");
  });
});
