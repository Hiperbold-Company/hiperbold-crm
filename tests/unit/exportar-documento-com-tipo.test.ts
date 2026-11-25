/**
 * Exportação nos EUA: o documento sai rotulado pelo TIPO gravado (migration
 * 1020), não como "CPF". Brasil e Portugal seguem byte a byte como antes.
 */
import { describe, expect, it } from "vitest";

import {
  CABECALHO_DO_CSV,
  csvDosContatos,
  vcardDoContato,
  type ContatoParaExportar,
} from "@/lib/contacts/exportar";
import { montarCsvDeContatos, type ContatoParaCsv } from "@/lib/contacts/exportar-csv";
import { mapHeader, mapLinha, parseCsv } from "@/lib/contacts/csv";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

const contato: ContatoParaExportar = {
  name: "John Doe",
  display_name: null,
  email: "john@example.com",
  phone_number: "+14075551234",
  cpf: "A12345678",
  document_type: "us_passport",
  birthdate: null,
  tags: [],
};

describe("CSV de ida e volta (importável)", () => {
  it("nos EUA: coluna document + document_type com o código, que o importador lê de volta", () => {
    const csv = csvDosContatos([contato], { comTipoDeDocumento: true });
    const [cab, linha] = csv.slice(1).trim().split("\n");
    expect(cab).toBe("name,display_name,email,phone_number,document,document_type,birthdate,tags");
    expect(cab).not.toMatch(/\bcpf\b/);
    expect(linha).toContain("A12345678,us_passport");

    const perfil = perfilDoPais("US");
    const linhas = parseCsv(csv);
    const { indices } = mapHeader(linhas[0]!, undefined, perfil.documento, perfil.tiposDeDocumento);
    const lido = mapLinha(
      linhas[1]!,
      indices,
      undefined,
      perfil.documento,
      undefined,
      perfil.tiposDeDocumento,
      perfil.codigo,
    );
    expect(lido.contato).toMatchObject({ cpf: "A12345678", document_type: "us_passport" });
  });

  it("no Brasil o cabeçalho e a linha não mudam", () => {
    const br = { ...contato, cpf: "12345678909", document_type: null };
    const csv = csvDosContatos([br]);
    expect(csv.slice(1).split("\n")[0]).toBe(CABECALHO_DO_CSV);
    expect(CABECALHO_DO_CSV).toContain("cpf");
  });
});

describe("vCard", () => {
  it("nos EUA a nota leva o rótulo do tipo, não CPF", () => {
    const card = vcardDoContato(contato)!;
    expect(card).toContain("NOTE:Passaporte americano (US Passport) A12345678");
    expect(card).not.toContain("NOTE:CPF");
  });

  it("sem tipo (Brasil) segue NOTE:CPF", () => {
    const card = vcardDoContato({ ...contato, cpf: "12345678909", document_type: null })!;
    expect(card).toContain("NOTE:CPF 12345678909");
  });
});

describe("CSV de planilha (exportação filtrada)", () => {
  const base: ContatoParaCsv = {
    name: "John Doe",
    email: null,
    phone_number: null,
    tags: null,
    source: null,
    created_at: null,
    last_activity_at: null,
    custom_fields: null,
    cpf: "A12345678",
    document_type: "us_passport",
  };
  const ref = { funis: new Map<string, string>(), etapas: new Map<string, string>(), comCpf: true };

  it("nos EUA: colunas Documento e Tipo de documento com o rótulo", () => {
    const [cab, linha] = montarCsvDeContatos([base], { ...ref, comTipoDeDocumento: true })
      .slice(1)
      .split("\r\n");
    expect(cab).toContain("Documento,Tipo de documento");
    expect(cab).not.toContain("CPF");
    expect(linha).toContain("A12345678,Passaporte americano (US Passport)");
  });

  it("sem o país com tipo segue a coluna CPF, sem coluna de tipo", () => {
    const [cab] = montarCsvDeContatos([{ ...base, document_type: null }], ref).slice(1).split("\r\n");
    expect(cab).toContain("CPF");
    expect(cab).not.toContain("Tipo de documento");
  });
});
