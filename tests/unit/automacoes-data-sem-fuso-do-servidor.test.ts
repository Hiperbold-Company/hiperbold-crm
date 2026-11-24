/**
 * HIDRATAÇÃO DA LISTA DE AUTOMAÇÕES (React #418 na prévia, 24/11).
 *
 * A "Última execução em DD/MM/AAAA" é desenhada duas vezes: no servidor (contêiner
 * em UTC) e no navegador (fuso de quem abre). Formatada sem fuso fixo, uma execução
 * no fim da noite já é "amanhã" em UTC — o texto do servidor difere do cliente e o
 * React recusa a hidratação. A data sai no FUSO DA EMPRESA ativa
 * (`organizations.timezone`), igual nos dois lados; sem fuso válido, no padrão.
 */
import { afterEach, describe, expect, it } from "vitest";

import { dataDaUltimaExecucao } from "@/lib/automacoes/data-da-lista";

const tzOriginal = process.env.TZ;
afterEach(() => {
  process.env.TZ = tzOriginal;
});

function noProcesso(tz: string, ...args: Parameters<typeof dataDaUltimaExecucao>) {
  process.env.TZ = tz;
  return dataDaUltimaExecucao(...args);
}

// 23/11/2026 22:30 em Brasília = 24/11/2026 01:30 UTC = 24/11/2026 10:30 em Tóquio
const fimDaNoite = "2026-11-24T01:30:00.000Z";

describe("dataDaUltimaExecucao — fuso da empresa, o mesmo texto no servidor e no navegador", () => {
  it("o fuso do processo não muda a data (servidor UTC × navegador Brasília)", () => {
    const servidor = noProcesso("UTC", fimDaNoite, "pt-BR", "America/Sao_Paulo");
    const navegador = noProcesso("America/Sao_Paulo", fimDaNoite, "pt-BR", "America/Sao_Paulo");
    expect(servidor).toBe(navegador);
    expect(servidor).toBe("23/11/2026");
  });

  it("empresa fora do Brasil vê a data do fuso dela, não a de Brasília", () => {
    expect(noProcesso("America/Sao_Paulo", fimDaNoite, "pt-BR", "Asia/Tokyo")).toBe("24/11/2026");
  });

  it("sem fuso, ou com fuso que o Intl recusa, cai no padrão — e continua igual nos dois lados", () => {
    for (const fuso of [null, undefined, "", "Brasília"]) {
      expect(noProcesso("UTC", fimDaNoite, "pt-BR", fuso)).toBe("23/11/2026");
      expect(noProcesso("Asia/Tokyo", fimDaNoite, "pt-BR", fuso)).toBe("23/11/2026");
    }
  });

  it("segue o idioma da pessoa", () => {
    expect(noProcesso("UTC", fimDaNoite, "en", "America/Sao_Paulo")).toBe("11/23/2026");
  });
});
