/**
 * `lib/documentos/cpf-cnpj.ts`: máscara de digitação e validação por dígito verificador de CPF/CNPJ,
 * a mesma função do formulário do pagador e da action de compra.
 */
import { describe, expect, it } from "vitest";

import {
  cnpjValido,
  cpfValido,
  documentoValido,
  erroDoDocumento,
  formatarDocumento,
  somenteDigitos,
} from "@/lib/documentos/cpf-cnpj";

describe("cpfValido", () => {
  it.each(["111.444.777-35", "123.456.789-09", "11144477735", "529.982.247-25"])("aceita %s", (cpf) => {
    expect(cpfValido(cpf)).toBe(true);
  });

  it.each(["000.000.000-00", "111.111.111-11", "999.999.999-99", "123.456.789-10", "111.444.777-36", "", "123"])(
    "recusa %s",
    (cpf) => {
      expect(cpfValido(cpf)).toBe(false);
    },
  );

  it("recusa mais de 11 dígitos", () => {
    expect(cpfValido("111.444.777-355")).toBe(false);
  });
});

describe("cnpjValido", () => {
  it.each(["11.222.333/0001-81", "11222333000181"])("aceita %s", (cnpj) => {
    expect(cnpjValido(cnpj)).toBe(true);
  });

  it.each(["00.000.000/0000-00", "11.111.111/1111-11", "11.222.333/0001-82", "12.345.678/0001-99", "123"])(
    "recusa %s",
    (cnpj) => {
      expect(cnpjValido(cnpj)).toBe(false);
    },
  );

  it("recusa mais de 14 dígitos", () => {
    expect(cnpjValido("11.222.333/0001-811")).toBe(false);
  });
});

describe("documentoValido", () => {
  it("roteia pelo número de dígitos", () => {
    expect(documentoValido("111.444.777-35")).toBe(true);
    expect(documentoValido("11.222.333/0001-81")).toBe(true);
    expect(documentoValido("1114447773")).toBe(false);
    expect(documentoValido("111444777350")).toBe(false);
  });
});

describe("formatarDocumento", () => {
  it("formata CPF progressivamente enquanto digita", () => {
    expect(formatarDocumento("1")).toBe("1");
    expect(formatarDocumento("111")).toBe("111");
    expect(formatarDocumento("1114")).toBe("111.4");
    expect(formatarDocumento("111444")).toBe("111.444");
    expect(formatarDocumento("1114447")).toBe("111.444.7");
    expect(formatarDocumento("111444777")).toBe("111.444.777");
    expect(formatarDocumento("1114447773")).toBe("111.444.777-3");
    expect(formatarDocumento("11144477735")).toBe("111.444.777-35");
  });

  it("do 12º dígito em diante vira CNPJ", () => {
    expect(formatarDocumento("111444777350")).toBe("11.144.477/7350");
    expect(formatarDocumento("11222333000181")).toBe("11.222.333/0001-81");
  });

  it("nunca passa de 14 dígitos", () => {
    expect(formatarDocumento("112223330001819999")).toBe("11.222.333/0001-81");
  });

  it("colar valor cru ou já formatado dá o mesmo resultado; letras e espaços saem", () => {
    expect(formatarDocumento("11144477735")).toBe("111.444.777-35");
    expect(formatarDocumento(" 111.444.777-35 ")).toBe("111.444.777-35");
    expect(formatarDocumento("11.222.333/0001-81")).toBe("11.222.333/0001-81");
    expect(formatarDocumento("abc1x1")).toBe("11");
    expect(formatarDocumento("")).toBe("");
  });

  it("é idempotente (reformatar o que já está formatado não muda nada)", () => {
    for (const v of ["1", "1114", "11144477735", "111444777350", "11222333000181"]) {
      expect(formatarDocumento(formatarDocumento(v))).toBe(formatarDocumento(v));
    }
  });

  it("somenteDigitos devolve só os dígitos que seguem ao Asaas", () => {
    expect(somenteDigitos(formatarDocumento("11144477735"))).toBe("11144477735");
  });
});

describe("erroDoDocumento", () => {
  it("devolve a mensagem de cada caso", () => {
    expect(erroDoDocumento("000.000.000-00")).toBe("CPF inválido");
    expect(erroDoDocumento("11.222.333/0001-82")).toBe("CNPJ inválido");
    expect(erroDoDocumento("123")).toBe("Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
    expect(erroDoDocumento("")).toBe("Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
    expect(erroDoDocumento("111.444.777-355")).toBe("Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
  });

  it("documento válido não tem erro", () => {
    expect(erroDoDocumento("111.444.777-35")).toBeNull();
    expect(erroDoDocumento("11.222.333/0001-81")).toBeNull();
  });

  it("digitação em curso (exigirCompleto=false) só reclama de documento completo e errado", () => {
    expect(erroDoDocumento("123", false)).toBeNull();
    expect(erroDoDocumento("", false)).toBeNull();
    expect(erroDoDocumento("123.456.789-10", false)).toBe("CPF inválido");
  });
});
