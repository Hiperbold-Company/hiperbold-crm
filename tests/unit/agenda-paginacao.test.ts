import { expect, it, vi } from "vitest";
import { protecaoAgendaPg, protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { logger } from "@/lib/logger";
const now = new Date("2026-09-06T12:00:00Z");
it("páginas truncadas abaixo do limit são lidas até vazio; protetor após 1000 coincide com PG e barra efeito", async () => {
  const rows = Array.from({ length: 1101 }, (_, n) => ({
    id: String(n).padStart(5, "0"),
    contact_id: "contact",
    revision: 1,
    status: "confirmed",
    starts_at: n === 1100 ? "2099-01-01T12:00:00Z" : "2020-01-01T12:00:00Z",
    ends_at: n === 1100 ? "2099-01-01T13:00:00Z" : "2020-01-01T13:00:00Z",
  }));
  const cursors: string[] = [];
  const db = {
    from: (table: string) => {
      let cursor = "";
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        gt: (_key: string, value: string) => {
          cursor = value;
          return q;
        },
        single: async () => ({ data: { settings: {} }, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          cursors.push(cursor);
          return Promise.resolve({
            data:
              table === "calendar_appointments"
                ? rows.filter((r) => r.id > cursor).slice(0, 127)
                : [],
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  const a = (await protecaoAgendaSupabase(db as never, "org", ["contact"], now)).get("contact");
  const pg = {
    query: async (sql: string) => ({
      rows: sql.includes("calendar_appointments") ? rows : [{ settings: {} }],
    }),
  };
  expect(a).toEqual(await protecaoAgendaPg(pg as never, "org", "contact", now));
  expect(a).toMatchObject({ adiar: true, appointment_id: "01100" });
  expect(cursors.at(-1)).toBe("01100");
  await expect(
    assertAgendaEffectSupabase(db as never, { organizationId: "org", contactId: "contact" }),
  ).rejects.toMatchObject({ protection: { adiar: true, appointment_id: "01100" } });
});
it("falha de página posterior não transforma leitura parcial em ausência", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  let second = false;
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    order: () => q,
    limit: () => q,
    gt: () => {
      second = true;
      return q;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        second
          ? { data: null, error: { message: "page unavailable" } }
          : { data: [{ id: "1", contact_id: "c" }], error: null },
      ).then(resolve),
  };
  expect(
    (await protecaoAgendaSupabase({ from: () => q } as never, "org", ["c"], now)).get("c"),
  ).toMatchObject({ adiar: true, motivo: "leitura_indisponivel" });
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

it("lista grande de contatos vai em blocos: nenhuma consulta passa do teto e o compromisso do último bloco ainda protege", async () => {
  // CBEXS, 28/10/2026: o radar passava milhares de contatos num único `in.(...)`,
  // a URL estourava e o radar inteiro caía em radar_agenda_indisponivel.
  const { CONTATOS_POR_CONSULTA_DA_AGENDA } = await import("@/lib/agenda/protecao-followup");
  const contatos = Array.from({ length: 1000 }, (_, n) => `c${String(n).padStart(4, "0")}`);
  const ultimo = contatos.at(-1)!;
  const tamanhos: number[] = [];
  const db = {
    from: () => {
      let bloco: string[] = [];
      let cursor = "";
      const q = {
        select: () => q,
        eq: () => q,
        in: (coluna: string, valores: string[]) => {
          if (coluna === "contact_id") bloco = valores;
          return q;
        },
        order: () => q,
        limit: () => q,
        gt: (_k: string, v: string) => {
          cursor = v;
          return q;
        },
        single: async () => ({ data: { settings: {} }, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          tamanhos.push(bloco.length);
          const data =
            !cursor && bloco.includes(ultimo)
              ? [
                  {
                    id: "a1",
                    contact_id: ultimo,
                    revision: 1,
                    status: "confirmed",
                    starts_at: "2099-01-01T12:00:00Z",
                    ends_at: "2099-01-01T13:00:00Z",
                  },
                ]
              : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  const mapa = await protecaoAgendaSupabase(db as never, "org", contatos, now);
  expect(Math.max(...tamanhos)).toBeLessThanOrEqual(CONTATOS_POR_CONSULTA_DA_AGENDA);
  expect(mapa.get(ultimo)).toMatchObject({ adiar: true, appointment_id: "a1" });
  expect([...mapa.values()].some((p) => p.motivo === "leitura_indisponivel")).toBe(false);
});
