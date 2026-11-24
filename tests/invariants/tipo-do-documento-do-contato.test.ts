/**
 * Migration 1020: `contacts.document_type` — o tipo do documento do contato (EUA).
 *
 * O que o banco garante, sem depender de quem escreve:
 *   1. o CHECK recusa valor fora do vocabulário (inclusive `us_ssn`);
 *   2. o gatilho zera o tipo quando o par do documento fica nulo;
 *   3. a anonimização (`fn_lgpd_cascade_redact_contact`) apaga o tipo junto com o par;
 *   4. tipo sem documento não sobrevive nem no INSERT;
 *   5. `authenticated` não troca o tipo pela REST sem trocar o número (42501),
 *      e o servidor (`service_role`, o helper admin) continua gravando.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "10201020-0000-4000-8000-000000000001";
const C1 = "10201020-3333-4000-8000-000000000001";
const C2 = "10201020-3333-4000-8000-000000000002";
const C3 = "10201020-3333-4000-8000-000000000003";
const C4 = "10201020-3333-4000-8000-000000000004";
const GESTOR = "10201020-1111-4000-8000-000000000001";

/** Roda e devolve o erro (vazio se passou), com o SQLSTATE na linha. */
function recusa(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? String(err)).replace(/\s+/g, " ");
  }
}

function comoGestor(script: string): string {
  return `
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GESTOR}","role":"authenticated"}', false);
    ${script}
  `;
}

function tipoDe(id: string): string {
  return lastLine(sql(`select coalesce(document_type, '<null>') from public.contacts where id = '${id}';`));
}

function limpar(): void {
  sql(`
    delete from public.contacts where organization_id = '${ORG}';
    delete from public.user_organizations where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    delete from auth.users where id = '${GESTOR}';
  `);
}

beforeAll(() => {
  limpar();
  sql(`
    insert into auth.users (id, email) values ('${GESTOR}', 'tipo-doc-gestor@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'tipo-doc-inv', 'Tipo Doc Invariant', 'Tipo Doc')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, cpf_hash, cpf_encrypted, document_type) values
      ('${C1}', '${ORG}', 'Com passaporte', 'hash-1', '\\x01', 'us_passport'),
      ('${C2}', '${ORG}', 'Com ITIN', 'hash-2', '\\x02', 'us_itin'),
      ('${C4}', '${ORG}', 'Alvo da REST', 'hash-4', '\\x04', 'us_passport');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GESTOR}', '${ORG}', 'manager', now())
      on conflict (user_id, organization_id) do nothing;
  `);
});

afterAll(() => limpar());

describe("contacts.document_type (migration 1020)", () => {
  it("o CHECK recusa SSN e qualquer valor fora da lista", () => {
    expect(() =>
      sql(`update public.contacts set document_type = 'us_ssn' where id = '${C1}';`),
    ).toThrow(/contacts_document_type_check/);
    expect(tipoDe(C1)).toBe("us_passport");
  });

  it("zerar o par do documento zera o tipo", () => {
    sql(`update public.contacts set cpf_hash = null, cpf_encrypted = null where id = '${C1}';`);
    expect(tipoDe(C1)).toBe("<null>");
  });

  it("tipo sem documento não nasce nem no INSERT", () => {
    sql(`insert into public.contacts (id, organization_id, display_name, document_type)
           values ('${C3}', '${ORG}', 'Só o tipo', 'us_passport');`);
    expect(tipoDe(C3)).toBe("<null>");
  });

  it("a anonimização LGPD apaga o tipo junto com o par", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${C2}', gen_random_uuid());`);
    expect(tipoDe(C2)).toBe("<null>");
    expect(
      lastLine(sql(`select (cpf_hash is null and cpf_encrypted is null)::text from public.contacts where id = '${C2}';`)),
    ).toBe("true");
  });

  it("authenticated (mesmo gerente) não troca o tipo sem o número: 42501, e nada muda", () => {
    const erro = recusa(comoGestor(`update public.contacts set document_type = 'br_cpf' where id = '${C4}';`));
    expect(erro).toMatch(/42501/);
    expect(tipoDe(C4)).toBe("us_passport");
  });

  it("authenticated (mesmo gerente) não lê o tipo pela REST: sem grant de coluna, como o par do CPF", () => {
    const erro = recusa(comoGestor(`select document_type from public.contacts where id = '${C4}';`));
    expect(erro).toMatch(/42501/);
    expect(erro).toMatch(/permission denied/);
    // Controle: a mesma sessão lê outra coluna do mesmo contato (a recusa é da coluna, não da linha).
    expect(recusa(comoGestor(`select display_name from public.contacts where id = '${C4}';`))).toBe("");
  });

  it("a catraca segura mesmo se alguém reabrir o grant de UPDATE no tipo (defesa em profundidade)", () => {
    const erro = recusa(`
      begin;
      grant update (document_type) on public.contacts to authenticated;
      ${comoGestor(`update public.contacts set document_type = 'br_cpf' where id = '${C4}';`)}
      rollback;
    `);
    expect(erro).toMatch(/42501/);
    expect(erro).toMatch(/só muda junto com o documento/);
    expect(tipoDe(C4)).toBe("us_passport");
  });

  it("authenticated pode mexer em outra coluna do mesmo contato (a catraca só olha o tipo)", () => {
    expect(recusa(comoGestor(`update public.contacts set display_name = 'Renomeado' where id = '${C4}';`))).toBe("");
    expect(tipoDe(C4)).toBe("us_passport");
  });

  it("o servidor (service_role) troca o tipo junto com o número, e também sozinho", () => {
    sql(`set role service_role;
         update public.contacts set cpf_hash = 'hash-4b', cpf_encrypted = '\\x05', document_type = 'us_itin' where id = '${C4}';`);
    expect(tipoDe(C4)).toBe("us_itin");
    sql(`set role service_role; update public.contacts set document_type = 'us_green_card' where id = '${C4}';`);
    expect(tipoDe(C4)).toBe("us_green_card");
  });
});
