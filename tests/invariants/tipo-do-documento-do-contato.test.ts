/**
 * Migration 1020: `contacts.document_type` — o tipo do documento do contato (EUA).
 *
 * O que o banco garante, sem depender de quem escreve:
 *   1. o CHECK recusa valor fora do vocabulário (inclusive `us_ssn`);
 *   2. o gatilho zera o tipo quando o par do documento fica nulo;
 *   3. a anonimização (`fn_lgpd_cascade_redact_contact`) apaga o tipo junto com o par;
 *   4. tipo sem documento não sobrevive nem no INSERT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "10201020-0000-4000-8000-000000000001";
const C1 = "10201020-3333-4000-8000-000000000001";
const C2 = "10201020-3333-4000-8000-000000000002";
const C3 = "10201020-3333-4000-8000-000000000003";

function tipoDe(id: string): string {
  return lastLine(sql(`select coalesce(document_type, '<null>') from public.contacts where id = '${id}';`));
}

function limpar(): void {
  sql(`
    delete from public.contacts where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
  `);
}

beforeAll(() => {
  limpar();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'tipo-doc-inv', 'Tipo Doc Invariant', 'Tipo Doc')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, cpf_hash, cpf_encrypted, document_type) values
      ('${C1}', '${ORG}', 'Com passaporte', 'hash-1', '\\x01', 'us_passport'),
      ('${C2}', '${ORG}', 'Com ITIN', 'hash-2', '\\x02', 'us_itin');
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
});
