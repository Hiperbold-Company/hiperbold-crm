import { beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov } from "./gov-helpers";
import { motivoDoErro, sql } from "./psql-transporte";

/**
 * A CATRACA DO CARIMBO VALE NO BANCO (migration 0967, D-215).
 *
 * `webhook_sources.exige_carimbo` liga sozinha no primeiro envio válido com `X-HiperCRM-Timestamp` e, ligada, faz a
 * fonte recusar envio sem carimbo (o que fecha o reenvio). Um manager tem UPDATE em `webhook_sources` pela REST: sem
 * trava no banco, `exige_carimbo = false` reabriria o formato antigo e, com ele, o reenvio. O gatilho
 * `trg_webhook_sources_catraca_do_carimbo` recusa true -> false para qualquer papel que não seja `service_role`.
 *
 * Cada caso roda numa transação desfeita; a fonte é criada pelo dono (postgres) e a escrita sob teste roda no papel.
 */

const FONTE = "0967c0de-5555-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
});

const prepara = (exige: boolean) => `
  insert into public.webhook_sources
    (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, exige_carimbo)
  values ('${FONTE}', '${GOV_ORG}', 'Fonte da catraca', 'wh-tok-${FONTE}', '${GOV_PIPELINE}', '${GOV_STAGE}', ${exige});
`;

const comoManager = `
  set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${GOV_MANAGER}"}', true);
`;

const estadoDaFonte = `select 'ESTADO|' || exige_carimbo from public.webhook_sources where id = '${FONTE}';`;

/** Roda na transação desfeita e devolve o erro (ou `null`) e o `exige_carimbo` visto ao final, se a transação seguiu. */
function tenta(corpo: string): { erro: string | null; estado: string | null } {
  try {
    const out = sql(`begin;\n${corpo}\n${estadoDaFonte}\nrollback;`);
    const linha = out.split("\n").find((l) => l.startsWith("ESTADO|"));
    return { erro: null, estado: linha ? linha.slice("ESTADO|".length) : null };
  } catch (err) {
    return { erro: motivoDoErro(err), estado: null };
  }
}

describe("migration 0967: exige_carimbo não desliga pelo banco", () => {
  it("manager (authenticated) NÃO consegue desligar exige_carimbo: 42501, e a fonte segue exigindo", () => {
    const r = tenta(`${prepara(true)} ${comoManager} update public.webhook_sources set exige_carimbo = false where id = '${FONTE}';`);
    expect(r.erro).toMatch(/exige_carimbo não pode ser desligado/);
    expect(r.erro).toMatch(/42501|permission|desligado/);
  });

  it("o desligamento também é recusado quando vem junto de outras colunas, e por UPDATE sem WHERE de linha", () => {
    const r = tenta(
      `${prepara(true)} ${comoManager} update public.webhook_sources set name = 'outro', exige_carimbo = false where id = '${FONTE}';`,
    );
    expect(r.erro).toMatch(/exige_carimbo não pode ser desligado/);
  });

  it("o service_role (servidor) pode desligar: a trava é sobre quem escreve, não sobre o valor", () => {
    const r = tenta(
      `${prepara(true)} set local role service_role; update public.webhook_sources set exige_carimbo = false where id = '${FONTE}';`,
    );
    expect(r.erro).toBeNull();
    expect(r.estado).toBe("false");
  });

  it("o manager continua podendo LIGAR e editar a fonte (a trava só fecha true -> false)", () => {
    const ligar = tenta(
      `${prepara(false)} ${comoManager} update public.webhook_sources set exige_carimbo = true where id = '${FONTE}';`,
    );
    expect(ligar.erro).toBeNull();
    expect(ligar.estado).toBe("true");

    const editar = tenta(
      `${prepara(true)} ${comoManager} update public.webhook_sources set name = 'Renomeada' where id = '${FONTE}';`,
    );
    expect(editar.erro).toBeNull();
    expect(editar.estado).toBe("true");
  });

  it("controle: sem o gatilho, o manager desliga a catraca (a sonda mede o defeito)", () => {
    const r = tenta(`
      ${prepara(true)}
      alter table public.webhook_sources disable trigger trg_webhook_sources_catraca_do_carimbo;
      ${comoManager}
      update public.webhook_sources set exige_carimbo = false where id = '${FONTE}';
    `);
    expect(r.erro).toBeNull();
    expect(r.estado).toBe("false");
  });

  it("a função do gatilho não é executável por public, anon nem authenticated (regra 9: as duas origens)", () => {
    const out = sql(`
      select 'PRIV|' || p.papel || ':' || has_function_privilege(p.papel, 'public.fn_webhook_sources_catraca_do_carimbo()', 'EXECUTE')
        from unnest(array['anon', 'authenticated']) p(papel);
      select 'PRIV|public:' || exists (
        select 1 from pg_proc f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
         where f.oid = 'public.fn_webhook_sources_catraca_do_carimbo()'::regprocedure
           and a.grantee = 0 and a.privilege_type = 'EXECUTE');
    `)
      .split("\n")
      .filter((l) => l.startsWith("PRIV|"));
    expect(out).toEqual(["PRIV|anon:false", "PRIV|authenticated:false", "PRIV|public:false"]);
  });
});
