import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_AGENT_A, GOV_ORG, GOV_VIEWER, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 1019: o membro responsável pela conexão (`channel_sessions.responsible_user_id`), no Postgres
 * de verdade, com DUAS organizações.
 *
 *  - a chave estrangeira composta recusa membro de outra organização (23503);
 *  - remover o membro (UPDATE de `revoked_at`) e torná-lo observador zeram o vínculo (gatilho);
 *  - apagar a linha do vínculo do membro zera só a coluna (`on delete set null (responsible_user_id)`);
 *  - `authenticated` LÊ a coluna (grant por coluna da 0998) e NÃO a grava pela API do banco
 *    (trava do servidor), nem chama a função de gravação;
 *  - `fn_gravar_membro_da_conexao` aplica a regra de membro ativo e não observador na escrita.
 *
 * Tudo em transação desfeita no fim: o banco compartilhado pelos arquivos de invariante não muda.
 */

const OUTRA_ORG = "cccccccc-1019-4000-8000-0000000000aa";
const DE_FORA = "cccccccc-1019-4000-8000-0000000000bb";
const CANAL = "cccccccc-1019-4000-8000-000000000001";
const CANAL_DA_OUTRA = "cccccccc-1019-4000-8000-000000000002";

/** Segunda organização, um membro dela e uma conexão em cada organização. */
const PREPARO = `
  insert into auth.users (id, email) values ('${DE_FORA}', 'de-fora-1019@invariant.test') on conflict do nothing;
  insert into public.organizations (id, slug, legal_name, display_name)
    values ('${OUTRA_ORG}', 'inv-1019-outra', 'Inv 1019 Outra', 'Inv 1019 Outra') on conflict do nothing;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${DE_FORA}', '${OUTRA_ORG}', 'admin', now()) on conflict do nothing;
  insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_path_token, webhook_secret_encrypted)
    values ('${CANAL}', '${GOV_ORG}', 'inv-1019-a', 'tok-1019-a', '\\x00'::bytea),
           ('${CANAL_DA_OUTRA}', '${OUTRA_ORG}', 'inv-1019-b', 'tok-1019-b', '\\x00'::bytea);
`;

/** Roda `corpo` (como postgres) depois do preparo, numa transação desfeita. */
function emTransacao(corpo: string): string {
  return sql(`
    begin;
    ${PREPARO}
    ${corpo}
    rollback;`);
}

function erroDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const responsavel = `select 'RESP:' || coalesce(responsible_user_id::text, 'nulo') from public.channel_sessions where id = '${CANAL}';`;
const vincular = (user: string) =>
  `update public.channel_sessions set responsible_user_id = '${user}' where id = '${CANAL}';`;

beforeAll(() => {
  seedGov();
});

describe("1019: membro responsável pela conexão", () => {
  it("a FK composta recusa membro de OUTRA organização (23503)", () => {
    const erro = erroDe(() => emTransacao(vincular(DE_FORA)));
    expect(erro, "gravou membro de outra organização SEM erro").not.toBeNull();
    expect(erro).toContain("channel_sessions_responsible_member_fkey");
  });

  it("CONTROLE: membro desta organização é aceito pela FK", () => {
    expect(emTransacao(`${vincular(GOV_AGENT_A)} ${responsavel}`)).toContain(`RESP:${GOV_AGENT_A}`);
  });

  it("remover o membro da equipe (revoked_at) zera o vínculo", () => {
    const out = emTransacao(`
      ${vincular(GOV_AGENT_A)}
      update public.user_organizations set revoked_at = now()
        where organization_id = '${GOV_ORG}' and user_id = '${GOV_AGENT_A}';
      ${responsavel}`);
    expect(out).toContain("RESP:nulo");
  });

  it("tornar o membro observador zera o vínculo", () => {
    const out = emTransacao(`
      ${vincular(GOV_AGENT_A)}
      update public.user_organizations set role = 'viewer'
        where organization_id = '${GOV_ORG}' and user_id = '${GOV_AGENT_A}';
      ${responsavel}`);
    expect(out).toContain("RESP:nulo");
  });

  it("CONTROLE: mudar o papel para outro que atende não zera", () => {
    const out = emTransacao(`
      ${vincular(GOV_AGENT_A)}
      update public.user_organizations set role = 'manager'
        where organization_id = '${GOV_ORG}' and user_id = '${GOV_AGENT_A}';
      ${responsavel}`);
    expect(out).toContain(`RESP:${GOV_AGENT_A}`);
  });

  it("DELETE do vínculo do membro zera só a coluna do membro (a conexão continua da organização)", () => {
    const out = emTransacao(`
      ${vincular(GOV_AGENT_A)}
      delete from public.user_organizations
        where organization_id = '${GOV_ORG}' and user_id = '${GOV_AGENT_A}';
      ${responsavel}
      select 'ORG:' || organization_id from public.channel_sessions where id = '${CANAL}';`);
    expect(out).toContain("RESP:nulo");
    expect(out).toContain(`ORG:${GOV_ORG}`);
  });

  it("authenticated lê a coluna (grant por coluna)", () => {
    const out = emTransacao(`
      ${vincular(GOV_AGENT_A)}
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
      ${responsavel}`);
    expect(out).toContain(`RESP:${GOV_AGENT_A}`);
  });

  it("admin da organização NÃO grava a coluna pela API do banco (trava do servidor, 42501)", () => {
    const erro = erroDe(() =>
      emTransacao(`
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
        ${vincular(GOV_AGENT_A)}`),
    );
    expect(erro, "o admin gravou o membro responsável direto pela REST").not.toBeNull();
    expect(erro).toContain("canal_ligacao_ao_provedor_e_do_servidor");
  });

  it("CONTROLE: o mesmo admin altera outra coluna da mesma linha", () => {
    const out = emTransacao(`
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
      with w as (update public.channel_sessions set display_name = 'Outro nome' where id = '${CANAL}' returning 1)
        select 'LINHAS:' || count(*) from w;`);
    expect(out).toContain("LINHAS:1");
  });

  it("authenticated não chama a função de gravação", () => {
    const erro = erroDe(() =>
      emTransacao(`
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
        select public.fn_gravar_membro_da_conexao('${GOV_ORG}', '${CANAL}', '${GOV_AGENT_A}');`),
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied");
  });

  describe("fn_gravar_membro_da_conexao (service_role)", () => {
    const gravar = (org: string, canal: string, user: string | null) => `
      set local role service_role;
      select 'R:' || public.fn_gravar_membro_da_conexao('${org}', '${canal}', ${user ? `'${user}'` : "null"})->>'resultado';`;

    it("membro ativo que atende: gravado", () => {
      const out = emTransacao(`${gravar(GOV_ORG, CANAL, GOV_AGENT_A)} reset role; ${responsavel}`);
      expect(out).toContain("R:gravado");
      expect(out).toContain(`RESP:${GOV_AGENT_A}`);
    });

    it("observador, membro removido e membro de outra organização: membro_invalido, nada muda", () => {
      for (const corpo of [
        gravar(GOV_ORG, CANAL, GOV_VIEWER),
        `update public.user_organizations set revoked_at = now()
           where organization_id = '${GOV_ORG}' and user_id = '${GOV_AGENT_A}';
         ${gravar(GOV_ORG, CANAL, GOV_AGENT_A)}`,
        gravar(GOV_ORG, CANAL, DE_FORA),
      ]) {
        const out = emTransacao(`${corpo} reset role; ${responsavel}`);
        expect(out).toContain("R:membro_invalido");
        expect(out).toContain("RESP:nulo");
      }
    });

    it("conexão de outra organização: canal_nao_encontrado, a linha dela não muda", () => {
      const out = emTransacao(`
        ${gravar(GOV_ORG, CANAL_DA_OUTRA, GOV_AGENT_A)}
        reset role;
        select 'OUTRA:' || coalesce(responsible_user_id::text, 'nulo') from public.channel_sessions where id = '${CANAL_DA_OUTRA}';`);
      expect(out).toContain("R:canal_nao_encontrado");
      expect(out).toContain("OUTRA:nulo");
    });

    it("tirar o membro (null): gravado e a coluna volta a nulo", () => {
      const out = emTransacao(`${vincular(GOV_AGENT_A)} ${gravar(GOV_ORG, CANAL, null)} reset role; ${responsavel}`);
      expect(out).toContain("R:gravado");
      expect(out).toContain("RESP:nulo");
    });
  });
});
