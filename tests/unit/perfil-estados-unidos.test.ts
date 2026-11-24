// @vitest-environment node
/**
 * O perfil dos ESTADOS UNIDOS (decisão do dono do produto, 24/11/2026): clientes
 * em Orlando, sem lei federal geral de proteção de dados a citar, e um documento
 * do contato que o titular ESCOLHE entre tipos válidos.
 *
 * As datas dos feriados são LITERAIS, copiadas da tabela do OPM
 * (opm.gov › Federal Holidays), e não saídas do gerador que se está testando.
 */
import { afterEach, describe, expect, it } from "vitest";

import { anonymize, padroesDaIngestao, padroesDePii } from "@/lib/ai/anonymize";
import {
  citacaoDaLei,
  paisesOferecidos,
  paisRevisado,
  perfilDoPais,
  PERFIS_DO_PAIS,
  semLeiGeralRevisada,
  validaDocumentoDoContato,
  type PerfilDoPais,
} from "@/lib/legal/perfil-do-pais";
import {
  isValidGreenCard,
  isValidItin,
  isValidPassaporteAmericano,
  tipoDeDocumento,
  TIPOS_DE_DOCUMENTO_DO_CONTATO,
} from "@/lib/legal/tipos-de-documento";
import { feriadosDosEstadosUnidosDoAno, HOLIDAYS_US_ISO } from "@/lib/lgpd/holidays-us";
import { computeDueAt } from "@/lib/lgpd/sla";

const US = perfilDoPais("US");

afterEach(() => {
  delete PERFIS_DO_PAIS.ZX;
  delete PERFIS_DO_PAIS.ZY;
});

describe("o perfil US existe e é oferecido", () => {
  it("é o perfil dos Estados Unidos, com fuso, idioma e telefone do país", () => {
    expect(US.codigo).toBe("US");
    expect(US.nome).toBe("Estados Unidos");
    expect(US.fusoDoSugerido).toBe("America/New_York");
    expect(US.idioma).toBe("en-US");
    expect(US.telefoneExemplo.startsWith("+1")).toBe(true);
    expect(US.empresa.rotuloNumero).toBe("EIN");
  });

  it("entra na lista do seletor, ao lado de Brasil e Portugal", () => {
    expect(paisesOferecidos().map((p) => p.codigo)).toEqual(["BR", "US", "PT"]);
  });

  it("não tem lei para citar, e isso foi REVISADO (não é um país sem revisão)", () => {
    expect(US.lei).toBeNull();
    expect(citacaoDaLei(US)).toBeNull();
    expect(semLeiGeralRevisada(US)).toBe(true);
    expect(US.semLeiGeral?.revisadaPorIa).toBe(true);
    expect(US.semLeiGeral?.fonte).toContain("Florida Digital Bill of Rights");
  });
});

describe("a régua do país sem lei geral não abre a porta para país sem revisão", () => {
  const base: PerfilDoPais = { ...perfilDoPais("US"), codigo: "ZX", nome: "Zxlândia" };

  it("`lei: null` SEM a revisão registrada não é oferecido", () => {
    const semRevisao: PerfilDoPais = { ...base, semLeiGeral: undefined };
    PERFIS_DO_PAIS.ZX = semRevisao;
    expect(paisRevisado(semRevisao)).toBe(false);
    expect(paisesOferecidos().map((p) => p.codigo)).not.toContain("ZX");
  });

  it("lei NÃO revisada mais a marca de 'sem lei geral' é contradição e não é oferecida", () => {
    const contraditorio: PerfilDoPais = {
      ...base,
      codigo: "ZY",
      lei: { nome: "Lei Z", numero: "1/2020", artigo: "Art. 1", revisada: false },
    };
    PERFIS_DO_PAIS.ZY = contraditorio;
    expect(paisRevisado(contraditorio)).toBe(false);
    expect(paisesOferecidos().map((p) => p.codigo)).not.toContain("ZY");
  });

  it("lei revisada mais a marca também não entra (as duas afirmações se excluem)", () => {
    const contraditorio: PerfilDoPais = {
      ...base,
      lei: { nome: "Lei Z", numero: "1/2020", artigo: "Art. 1", revisada: true },
    };
    expect(paisRevisado(contraditorio)).toBe(false);
  });

  it("Brasil e Portugal continuam entrando pela lei revisada", () => {
    expect(paisRevisado(perfilDoPais("BR"))).toBe(true);
    expect(paisRevisado(perfilDoPais("PT"))).toBe(true);
    expect(semLeiGeralRevisada(perfilDoPais("BR"))).toBe(false);
    expect(semLeiGeralRevisada(perfilDoPais("PT"))).toBe(false);
  });
});

describe("feriados federais (datas observadas do OPM)", () => {
  it("2026", () => {
    expect(feriadosDosEstadosUnidosDoAno(2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03", // 4 de julho é sábado
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
  });

  it("2027, com três observâncias e o Ano-Novo de 2028 em 31/12", () => {
    expect(feriadosDosEstadosUnidosDoAno(2027)).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-05-31",
      "2027-06-18", // Juneteenth é sábado
      "2027-07-05", // 4 de julho é domingo
      "2027-09-06",
      "2027-10-11",
      "2027-11-11",
      "2027-11-25",
      "2027-12-24", // Natal é sábado
      "2027-12-31", // 1/1/2028 é sábado
    ]);
  });

  it("2028 não tem folga em janeiro de Ano-Novo (ela recuou para 2027)", () => {
    expect(feriadosDosEstadosUnidosDoAno(2028).filter((d) => d.startsWith("2028-01-0"))).toEqual([]);
  });

  it("Juneteenth só existe a partir de 2021", () => {
    expect(feriadosDosEstadosUnidosDoAno(2020).some((d) => d.startsWith("2020-06-1"))).toBe(false);
    expect(feriadosDosEstadosUnidosDoAno(2021)).toContain("2021-06-18"); // 19/06/2021 foi sábado
  });

  it("o prazo em dias úteis pula o Thanksgiving no calendário do perfil (e não no do Brasil)", () => {
    // Quarta 25/11/2026 + 1 dia útil: nos EUA a quinta 26 é feriado, vence na sexta 27.
    const recebido = new Date("2026-11-25T15:00:00.000Z");
    expect(computeDueAt(recebido, 1, new Set(US.calendario.feriados)).toISOString().slice(0, 10)).toBe("2026-11-27");
    expect(computeDueAt(recebido, 1, new Set(perfilDoPais("BR").calendario.feriados)).toISOString().slice(0, 10)).toBe(
      "2026-11-26",
    );
  });

  it("é o calendário do perfil, sem data duplicada", () => {
    expect(US.calendario.feriados).toBe(HOLIDAYS_US_ISO);
    expect(new Set(HOLIDAYS_US_ISO).size).toBe(HOLIDAYS_US_ISO.length);
    expect(HOLIDAYS_US_ISO).toContain("2026-11-26");
  });
});

describe("os tipos de documento do contato", () => {
  it("a lista é a decidida, e o SSN não está nela", () => {
    expect([...TIPOS_DE_DOCUMENTO_DO_CONTATO]).toEqual([
      "us_drivers_license",
      "us_state_id",
      "us_passport",
      "us_green_card",
      "us_itin",
      "foreign_passport",
      "br_cpf",
    ]);
    expect(US.tiposDeDocumento?.map((t) => t.codigo)).toEqual([...TIPOS_DE_DOCUMENTO_DO_CONTATO]);
    expect(tipoDeDocumento("us_ssn")).toBeNull();
  });

  it("ITIN: começa com 9 e o 4.º/5.º dígitos nas faixas do IRS", () => {
    for (const v of ["912-70-1234", "900501234", "965-65-0000", "970-88-1111", "990-90-1234", "994-94-1234", "999-99-9999"]) {
      expect(isValidItin(v), v).toBe(true);
    }
    for (const v of ["812-70-1234", "912-49-1234", "912-66-1234", "912-89-1234", "912-93-1234", "91270123", "9127012345", "912-7A-1234"]) {
      expect(isValidItin(v), v).toBe(false);
    }
  });

  it("passaporte americano: 9 letras ou dígitos", () => {
    expect(isValidPassaporteAmericano("A12345678")).toBe(true);
    expect(isValidPassaporteAmericano("123456789")).toBe(true);
    expect(isValidPassaporteAmericano("a1234567")).toBe(false);
    expect(isValidPassaporteAmericano("A123456789")).toBe(false);
  });

  it("Green Card: 3 letras + 10 dígitos, ou A + 8 a 9 dígitos", () => {
    expect(isValidGreenCard("ABC1234567890")).toBe(true);
    expect(isValidGreenCard("eac1234567890")).toBe(true);
    expect(isValidGreenCard("A12345678")).toBe(true);
    expect(isValidGreenCard("A123456789")).toBe(true);
    expect(isValidGreenCard("AB1234567890")).toBe(false);
    expect(isValidGreenCard("A1234567")).toBe(false);
    expect(isValidGreenCard("B12345678")).toBe(false);
  });

  it("carteira de motorista, State ID e passaporte estrangeiro: 4 a 20 letras ou dígitos", () => {
    for (const tipo of ["us_drivers_license", "us_state_id", "foreign_passport"]) {
      expect(validaDocumentoDoContato(US, "S530-123-45-678-0", tipo).ok, tipo).toBe(true);
      expect(validaDocumentoDoContato(US, "ABC1", tipo).ok, tipo).toBe(true);
      expect(validaDocumentoDoContato(US, "AB1", tipo).ok, tipo).toBe(false);
      expect(validaDocumentoDoContato(US, "A".repeat(21), tipo).ok, tipo).toBe(false);
      expect(validaDocumentoDoContato(US, "AB#123", tipo).ok, tipo).toBe(false);
    }
  });

  it("CPF numa organização dos EUA confere o dígito verificador", () => {
    const valido = validaDocumentoDoContato(US, "529.982.247-25", "br_cpf");
    expect(valido).toEqual(expect.objectContaining({ ok: true, normalizado: "52998224725" }));
    expect(validaDocumentoDoContato(US, "529.982.247-24", "br_cpf")).toEqual(
      expect.objectContaining({ ok: false, motivo: "numero_invalido", mensagem: "CPF inválido" }),
    );
  });

  it("nos EUA o tipo é obrigatório e precisa ser da lista; SSN é recusado como tipo", () => {
    expect(validaDocumentoDoContato(US, "A12345678", undefined)).toEqual(
      expect.objectContaining({ ok: false, motivo: "tipo_obrigatorio" }),
    );
    expect(validaDocumentoDoContato(US, "123-45-6789", "us_ssn")).toEqual(
      expect.objectContaining({ ok: false, motivo: "tipo_invalido" }),
    );
  });

  it("normaliza para maiúsculas sem separador (é o que se cifra)", () => {
    expect(validaDocumentoDoContato(US, "a1234-5678", "us_passport")).toEqual(
      expect.objectContaining({ ok: true, normalizado: "A12345678" }),
    );
    expect(validaDocumentoDoContato(US, "912-70-1234", "us_itin")).toEqual(
      expect.objectContaining({ ok: true, normalizado: "912701234" }),
    );
  });

  it("Brasil e Portugal seguem sem tipo: tipo enviado é recusado, número na régua de sempre", () => {
    const br = perfilDoPais("BR");
    const pt = perfilDoPais("PT");
    expect(br.tiposDeDocumento).toBeUndefined();
    expect(pt.tiposDeDocumento).toBeUndefined();
    expect(validaDocumentoDoContato(br, "529.982.247-25", undefined)).toEqual({
      ok: true,
      tipo: null,
      normalizado: "52998224725",
    });
    expect(validaDocumentoDoContato(br, "529.982.247-25", "br_cpf")).toEqual(
      expect.objectContaining({ ok: false, motivo: "tipo_nao_aceito" }),
    );
    expect(validaDocumentoDoContato(pt, "123456789", undefined)).toEqual(
      expect.objectContaining({ ok: true, tipo: null }),
    );
  });
});

describe("o anonimizador do perfil US", () => {
  it("redige o SSN mesmo sem o produto coletá-lo", () => {
    const { anonymized } = anonymize("meu ssn é 123-45-6789", padroesDePii([US]));
    expect(anonymized).toContain("[SSN]");
    expect(anonymized).not.toContain("123-45-6789");
  });

  it("redige o telefone com +1", () => {
    const { anonymized } = anonymize("liga no +1 (407) 555-1234 amanhã", padroesDePii([US]));
    expect(anonymized).toContain("[TELEFONE]");
    expect(anonymized).not.toContain("555-1234");
  });

  it("a ingestão mantém o Brasil por baixo: CPF de cliente brasileiro em Orlando é redigido", () => {
    const { anonymized } = anonymize("CPF 529.982.247-25", padroesDaIngestao(US));
    expect(anonymized).toContain("[CPF]");
  });
});
