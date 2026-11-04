import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import {
  assentosOcupados, assinar, chaveDeCobranca, comoServidor, comoUsuario, corrida, criarOrg, criarPlano,
  criarUsuarios, erroDe, insercaoDeVinculo, numero, tornarPlatformAdmin, uuid, valor, vincular,
} from "./cobranca-helpers";

/**
 * O TETO DE PESSOAS DO PLANO — invariante 5 da spec da cobrança do revendedor
 * (§5, §12), migration 0583. Conta membro ativo e não provisório (convite
 * pendente não conta, D-10); só o vínculo que PASSA a ocupar vaga é conferido;
 * duas entradas simultâneas não passam juntas; estourou → PT402 com a mensagem
 * `limite_do_plano:assentos:<teto>` que lib/cobranca/limites.ts lê. E a sessão
 * não cria vínculo provisório: o provisório não conta e tem acesso pleno.
 */

const P = "c0b00004-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const pessoa = (n: number) => uuid(P, 100 + n);
const PLANO_2 = uuid(P, 901);
const PLANO_1 = uuid(P, 902);
const PLANO_SEM_TETO = uuid(P, 903);
const DONO = uuid(P, 950);
const CHAVE_DO_TENANT = uuid(P, 960);
const PROVISORIO_RECUSADO = /membro_provisorio_so_pelo_servidor|provisional_until_handover só pode ser gravado pelo servidor/;

beforeAll(() => {
  const gente: Array<readonly [string, string]> = [[DONO, "dono-assentos-0510@invariant.test"]];
  for (let n = 1; n <= 30; n++) gente.push([pessoa(n), `pessoa-${n}-assentos-0510@invariant.test`]);
  criarUsuarios(gente);
  tornarPlatformAdmin(DONO, "full", DONO);
  criarPlano({ id: PLANO_2, nome: "Duas pessoas", maxAssentos: 2 });
  criarPlano({ id: PLANO_1, nome: "Uma pessoa", maxAssentos: 1 });
  criarPlano({ id: PLANO_SEM_TETO, nome: "Sem teto" });
  for (let n = 1; n <= 10; n++) criarOrg(org(n), `cob-assentos-${n}`);
  chaveDeCobranca("ligado");
});

describe("inv. 5 — assentos", () => {
  it("⭐ teto 2: o terceiro vínculo é recusado com PT402, a mensagem que o app lê, e a contagem para em 2", () => {
    assinar(org(1), PLANO_2);
    vincular(pessoa(1), org(1), "admin");
    vincular(pessoa(2), org(1));
    const e = erroDe(`${insercaoDeVinculo(pessoa(3), org(1))};`);
    expect(e).toContain("PT402");
    // O contrato com lib/cobranca/limites.ts: a MENSAGEM carrega recurso e teto.
    expect(e).toContain("limite_do_plano:assentos:2");
    expect(e).toContain(`"recurso": "assentos"`);
    expect(e).toContain(`"limite": 2`);
    expect(assentosOcupados(org(1))).toBe(2);
  });

  it("revogado não ocupa vaga; reativá-lo acima do teto é recusado, inclusive pela sessão (rota de Equipe)", () => {
    assinar(org(2), PLANO_2);
    vincular(pessoa(4), org(2), "admin");
    vincular(pessoa(5), org(2));
    sql(`update public.user_organizations set revoked_at = now() where organization_id = '${org(2)}' and user_id = '${pessoa(5)}';`);
    vincular(pessoa(6), org(2));
    const reativar = `update public.user_organizations set revoked_at = null where organization_id = '${org(2)}' and user_id = '${pessoa(5)}'`;
    expect(erroDe(`${reativar};`)).toContain("PT402");
    expect(erroDe(comoUsuario(pessoa(4), reativar))).toContain("PT402");
    expect(assentosOcupados(org(2))).toBe(2);
  });

  it("⭐ aceite de convite acima do teto é recusado — a trava de verdade é no aceite (D-10)", () => {
    assinar(org(3), PLANO_1);
    vincular(pessoa(7), org(3), "admin");
    const e = erroDe(comoServidor(
      `select public.fn_accept_team_invite('${pessoa(8)}', '${org(3)}', 'agent', null, null, now(), '{"preset":"completa"}'::jsonb)`,
    ));
    expect(e).toContain("PT402");
    expect(valor(`select count(*) from public.user_organizations where organization_id = '${org(3)}' and user_id = '${pessoa(8)}';`)).toBe("0");
  });

  it("⭐ o criador de fn_create_tenant_with_owner entra como membro da agência e não ocupa vaga (0974)", () => {
    // Regra do fork (0974): quando o dono informado é outra pessoa, o criador nasce
    // `membro_da_agencia` (antes: provisório). Ele não conta vaga do plano e não é apagado
    // na entrega; por isso não há mais "torná-lo definitivo" para conferir aqui.
    const nova = valor(comoServidor(`select public.fn_create_tenant_with_owner('${DONO}', '${CHAVE_DO_TENANT}',
      '{"display_name":"Cob Assentos Provisorio","slug":"cob-assentos-provisorio","owner_email":"dono-real-0510@invariant.test"}'::jsonb,
      'abcd')->>'id'`));
    expect(valor(`select membro_da_agencia::text from public.user_organizations where organization_id = '${nova}' and user_id = '${DONO}';`)).toBe("true");
    assinar(nova, PLANO_1);
    vincular(pessoa(9), nova, "admin");
    expect(erroDe(`${insercaoDeVinculo(pessoa(10), nova)};`)).toContain("PT402");
    expect(numero(`select count(*) from public.user_organizations
                    where organization_id = '${nova}' and revoked_at is null and not membro_da_agencia;`)).toBe(1);
  });

  it("⭐ a sessão não cria vínculo provisório, nem o admin do tenant pelo PostgREST", () => {
    vincular(pessoa(11), org(5), "admin");
    const insercao = erroDe(comoUsuario(pessoa(11),
      `insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
         values ('${pessoa(12)}', '${org(5)}', 'agent', now(), true)`));
    expect(insercao).toContain("42501");
    // Dois gatilhos recusam; o do fork (trg_billing_trava_user_organizations_provisorio) dispara
    // primeiro pela ordem alfabética, com a própria mensagem. Qualquer um dos dois é a recusa certa.
    expect(insercao).toMatch(PROVISORIO_RECUSADO);
    vincular(pessoa(13), org(5));
    const promocao = erroDe(comoUsuario(pessoa(11),
      `update public.user_organizations set provisional_until_handover = true where organization_id = '${org(5)}' and user_id = '${pessoa(13)}'`));
    expect(promocao).toContain("42501");
    expect(promocao).toMatch(PROVISORIO_RECUSADO);
    expect(valor(`select count(*) from public.user_organizations where organization_id = '${org(5)}' and provisional_until_handover;`)).toBe("0");
  });

  it("controle: a sessão não grava vínculo de outra pessoa (0929); o servidor, que as rotas de Equipe usam, inclui e revoga", () => {
    // Regra do fork (0929, D-125): quem não é o servidor só insere vínculo para si mesmo e não
    // muda revoked_at. As rotas de Equipe gravam com o cliente de serviço depois de conferir o admin.
    expect(erroDe(comoUsuario(pessoa(11), insercaoDeVinculo(pessoa(14), org(5))))).toContain("42501");
    expect(valor(comoServidor(`with x as (${insercaoDeVinculo(pessoa(14), org(5))} returning 1) select count(*) from x`))).toBe("1");
    sql(`insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
           values ('${pessoa(15)}', '${org(5)}', 'admin', now(), true);`);
    const revogar = `update public.user_organizations set revoked_at = now() where organization_id = '${org(5)}' and user_id = '${pessoa(15)}'`;
    expect(erroDe(comoUsuario(pessoa(11), revogar))).toContain("42501");
    expect(valor(comoServidor(`with x as (${revogar} returning 1) select count(*) from x`))).toBe("1");
  });

  it("mudar a organização de um vínculo ativo conta no destino", () => {
    assinar(org(6), PLANO_1);
    vincular(pessoa(16), org(6), "admin");
    vincular(pessoa(17), org(7));
    expect(erroDe(`update public.user_organizations set organization_id = '${org(6)}'
                    where organization_id = '${org(7)}' and user_id = '${pessoa(17)}';`)).toContain("PT402");
    expect(assentosOcupados(org(6))).toBe(1);
  });

  it("⭐ duas entradas ao mesmo tempo com uma vaga: exatamente uma passa", async () => {
    assinar(org(8), PLANO_2);
    vincular(pessoa(18), org(8), "admin");
    const [primeira, segunda] = await corrida(insercaoDeVinculo(pessoa(19), org(8)), insercaoDeVinculo(pessoa(20), org(8)));
    expect(primeira.ok, primeira.saida).toBe(true);
    expect(segunda.ok, "a segunda entrou junto: a trava consultiva sumiu").toBe(false);
    expect(segunda.saida).toContain("PT402");
    expect(assentosOcupados(org(8))).toBe(2);
  });

  it("sem limite com chave desligada/ausente, org isenta ou plano sem teto; acima do teto, só não cresce (D-4)", () => {
    assinar(org(9), PLANO_1);
    vincular(pessoa(21), org(9), "admin");
    try {
      chaveDeCobranca("desligado");
      vincular(pessoa(22), org(9));
      chaveDeCobranca("ausente");
      vincular(pessoa(23), org(9));
    } finally {
      chaveDeCobranca("ligado");
    }
    expect(assentosOcupados(org(9))).toBe(3);
    expect(erroDe(`${insercaoDeVinculo(pessoa(30), org(9))};`)).toContain("PT402");
    for (const n of [24, 25, 26]) vincular(pessoa(n), org(7));
    assinar(org(10), PLANO_SEM_TETO);
    for (const n of [27, 28, 29]) vincular(pessoa(n), org(10));
    expect(assentosOcupados(org(10))).toBe(3);
  });
});
