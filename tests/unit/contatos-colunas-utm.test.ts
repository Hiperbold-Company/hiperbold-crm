import { describe, expect, it } from "vitest";

import { withUtms } from "@/app/api/v1/contacts/_handler";
import { rotuloDaColuna } from "@/components/contacts/PersonalizarColunasDialog";
import {
  COLUNAS_DO_SISTEMA,
  MAXIMO_DE_COLUNAS,
  colunaValida,
  ehColunaFixa,
  normalizarColunas,
  pedeUtm,
} from "@/lib/contacts/colunas-da-lista";
import { CHAVES_DE_UTM, UTM_LINHAS_POR_PAGINA, utmsMaisRecentesPorContato } from "@/lib/contacts/utm-dos-negocios";
import { contactListQuerySchema } from "@/lib/schemas";
import type { Contact } from "@/lib/types/contacts";

/**
 * Colunas de UTM na lista de Contatos. O UTM mora no NEGÓCIO (`crm_leads.custom_fields`); a coluna
 * mostra o valor do negócio mais recente do contato que tem a chave, calculado na leitura.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("o valor de cada UTM: o negócio mais recente que tem a chave", () => {
  it("com vários negócios, ganha o mais recente, qualquer que seja a ordem de entrada", () => {
    const r = utmsMaisRecentesPorContato([
      { contact_id: A, created_at: "2026-01-01T10:00:00Z", utm_source: "facebook" },
      { contact_id: A, created_at: "2026-03-01T10:00:00Z", utm_source: "google" },
      { contact_id: A, created_at: "2026-02-01T10:00:00Z", utm_source: "instagram" },
    ]);
    expect(r.get(A)).toEqual({ utm_source: "google" });
  });

  it("negócio mais recente SEM a chave cede para o anterior que a tem (chave a chave)", () => {
    const r = utmsMaisRecentesPorContato([
      { contact_id: A, created_at: "2026-01-01T10:00:00Z", utm_source: "facebook", utm_term: "sofa" },
      { contact_id: A, created_at: "2026-05-01T10:00:00Z", utm_source: "google", utm_term: "  " },
      { contact_id: A, created_at: "2026-06-01T10:00:00Z", utm_campaign: "black-friday", utm_source: null },
    ]);
    expect(r.get(A)).toEqual({ utm_source: "google", utm_term: "sofa", utm_campaign: "black-friday" });
  });

  it("sem negócio com UTM, o contato não tem valor; contatos não se misturam", () => {
    const r = utmsMaisRecentesPorContato([
      { contact_id: A, created_at: "2026-01-01T10:00:00Z" },
      { contact_id: A, created_at: "2026-01-02T10:00:00Z", utm_medium: "" },
      { contact_id: B, created_at: "2026-01-03T10:00:00Z", utm_medium: "cpc" },
      { contact_id: null, created_at: "2026-09-01T10:00:00Z", utm_medium: "orfao" },
    ]);
    expect(r.get(A)).toBeUndefined();
    expect(r.get(B)).toEqual({ utm_medium: "cpc" });
    expect(utmsMaisRecentesPorContato([]).size).toBe(0);
  });
});

describe("as 5 colunas no catálogo do diálogo", () => {
  const t = (s: string) => s;

  it("as 5 estão no catálogo, são válidas, não são fixas e têm rótulo com a chave", () => {
    const ids = COLUNAS_DO_SISTEMA.map((c) => c.id as string);
    for (const chave of CHAVES_DE_UTM) {
      expect(ids, chave).toContain(chave);
      expect(colunaValida(chave)).toBe(true);
      expect(ehColunaFixa(chave)).toBe(false);
      expect(rotuloDaColuna(chave, [], t)).toMatch(new RegExp(`^UTM .+ \\(${chave}\\)$`));
    }
    expect(rotuloDaColuna("utm_source", [], t)).toBe("UTM origem (utm_source)");
    // Ações continua sendo a última do catálogo.
    expect(ids.at(-1)).toBe("acoes");
  });

  it(`o limite de ${MAXIMO_DE_COLUNAS} colunas continua valendo com as de UTM`, () => {
    const muitas = [...CHAVES_DE_UTM, "email", "telefone", "tags", "origem", "status", "aniversario", "ultima_mensagem"];
    const r = normalizarColunas(muitas);
    expect(r).toHaveLength(MAXIMO_DE_COLUNAS);
    expect(r[0]).toBe("nome");
    expect(r.at(-1)).toBe("acoes");
    expect(r.slice(1, 6)).toEqual([...CHAVES_DE_UTM]);
  });

  it("a lista só pede UTM quando alguma coluna de UTM está escolhida", () => {
    expect(pedeUtm(["nome", "email", "acoes"])).toBe(false);
    expect(pedeUtm(["nome", "cf:utm_source", "acoes"])).toBe(false);
    expect(pedeUtm(["nome", "utm_campaign", "acoes"])).toBe(true);
  });

  it("o parâmetro `com_utm` da rota é validado", () => {
    expect(contactListQuerySchema.parse({ com_utm: "1" }).com_utm).toBe(true);
    expect(contactListQuerySchema.parse({ com_utm: "0" }).com_utm).toBe(false);
    expect(contactListQuerySchema.parse({}).com_utm).toBeUndefined();
    // O handler valida de novo o que a rota já validou: o booleano também passa.
    expect(contactListQuerySchema.parse(contactListQuerySchema.parse({ com_utm: "1" })).com_utm).toBe(true);
    expect(contactListQuerySchema.safeParse({ com_utm: "sim" }).success).toBe(false);
  });
});

describe("a busca dos UTMs da página", () => {
  /** Cliente Supabase falso: grava cada chamada do builder e devolve as linhas dadas. */
  function clienteFalso(linhas: unknown[]) {
    const chamadas: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        chamadas.push([m, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: linhas, error: null });
    const supabase = {
      from: (tabela: string) => {
        chamadas.push(["from", tabela]);
        return builder;
      },
    };
    return { supabase: supabase as never, chamadas };
  }

  const contato = (id: string) => ({ id }) as unknown as Contact;

  it("UMA consulta em crm_leads, filtrada pela organização e pelos ids da página", async () => {
    const { supabase, chamadas } = clienteFalso([
      { contact_id: A, created_at: "2026-01-01T00:00:00Z", utm_source: "facebook" },
      { contact_id: A, created_at: "2026-02-01T00:00:00Z", utm_source: "google" },
    ]);
    const r = await withUtms(supabase, "org-da-sessao", [contato(A), contato(B)]);
    expect(r.error).toBeNull();
    expect(chamadas.filter(([m]) => m === "from")).toEqual([["from", "crm_leads"]]);
    expect(chamadas).toContainEqual(["eq", "organization_id", "org-da-sessao"]);
    expect(chamadas).toContainEqual(["in", "contact_id", [A, B]]);
    // Mais recente primeiro e teto explícito: um corte por `max_rows` perde só os antigos.
    expect(chamadas).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(chamadas).toContainEqual(["limit", UTM_LINHAS_POR_PAGINA]);
    expect(r.contacts.map((c) => c.utms)).toEqual([{ utm_source: "google" }, {}]);
  });

  it("página vazia não consulta nada", async () => {
    const { supabase, chamadas } = clienteFalso([]);
    expect((await withUtms(supabase, "org", [])).contacts).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});
