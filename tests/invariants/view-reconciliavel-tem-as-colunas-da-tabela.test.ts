import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * D-194 (migration 1011): a view `calendar_google_reconcilable_appointments` é
 * `select a.* from calendar_appointments a where ...`. O Postgres expande o `*` na
 * criação, então uma view criada ANTES de colunas novas da tabela base fica sem elas.
 * Medido: uma aplicação do baseline (o `install.sh`) deixava a view com 51 colunas
 * contra 79 da tabela; só o `update.sh` a levava a 79 (e fora de ordem, porque
 * `create or replace view` acrescenta ao fim).
 *
 * A régua: depois de TODO o baseline, a view tem as MESMAS colunas da tabela, na MESMA
 * ordem. (O harness aplica o baseline duas vezes; a ordem é o que denuncia a view que
 * só foi completada pelo update em vez de recriada no fim do apêndice.)
 */
function colunas(relacao: string): string[] {
  const out = sql(
    `select attname from pg_attribute where attrelid = 'public.${relacao}'::regclass and attnum > 0 and not attisdropped order by attnum;`,
  );
  return out === "" ? [] : out.split("\n");
}

describe("view de reconciliação do Google acompanha a tabela da agenda", () => {
  it("tem as mesmas colunas de calendar_appointments, na mesma ordem", () => {
    const tabela = colunas("calendar_appointments");
    const view = colunas("calendar_google_reconcilable_appointments");
    expect(tabela.length).toBeGreaterThan(70);
    expect(view).toEqual(tabela);
  });

  it("continua com security_invoker e só o service_role lê", () => {
    expect(
      sql(
        `select coalesce(reloptions::text, '') from pg_class where oid = 'public.calendar_google_reconcilable_appointments'::regclass;`,
      ),
    ).toContain("security_invoker=true");
    for (const papel of ["anon", "authenticated"]) {
      expect(
        sql(
          `select has_table_privilege('${papel}', 'public.calendar_google_reconcilable_appointments', 'SELECT');`,
        ),
      ).toBe("f");
    }
    expect(
      sql(
        `select has_table_privilege('service_role', 'public.calendar_google_reconcilable_appointments', 'SELECT');`,
      ),
    ).toBe("t");
  });
});
