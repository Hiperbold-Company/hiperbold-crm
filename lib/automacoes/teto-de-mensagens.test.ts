import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  decidirTeto,
  metadataDeOrigemAutomacao,
  MOTIVO_TETO_EXCEDIDO,
  MOTIVO_TETO_INDISPONIVEL,
  podeEnviarMensagemAutomatica,
  TETO_DE_MENSAGENS_POR_HORA,
} from "./teto-de-mensagens";

/**
 * Banco de mentira que APLICA os filtros da consulta sobre linhas em memória:
 * o teste afirma o que conta e o que não conta, não a forma da chamada.
 */
type Linha = {
  organization_id: string;
  contact_id: string;
  direction: "inbound" | "outbound";
  created_at: string;
  metadata: Record<string, unknown>;
};

function bancoCom(linhas: Linha[], erro: { message: string } | null = null): SupabaseClient {
  const filtros: Array<(l: Linha) => boolean> = [];
  const q = {
    select: () => q,
    eq: (col: keyof Linha, val: unknown) => {
      filtros.push((l) => l[col] === val);
      return q;
    },
    in: (col: keyof Linha, vals: unknown[]) => {
      filtros.push((l) => vals.includes(l[col]));
      return q;
    },
    gte: (col: keyof Linha, val: string) => {
      filtros.push((l) => String(l[col]) >= val);
      return q;
    },
    not: (col: string, op: string, val: unknown) => {
      const m = /^metadata->(.+)$/.exec(col);
      if (!m || op !== "is" || val !== null) throw new Error(`filtro inesperado: ${col} ${op}`);
      filtros.push((l) => l.metadata[m[1]!] != null);
      return q;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve(erro ? { count: null, error: erro } : { count: linhas.filter((l) => filtros.every((f) => f(l))).length, error: null }),
  };
  return { from: (t: string) => (t === "messages" ? q : null) } as unknown as SupabaseClient;
}

const ORG = "org-a";
const CONTATO = "contato-1";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const minutosAntes = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();
const daAutomacao = metadataDeOrigemAutomacao({ enrollmentId: "enr-1", pointerId: "ptr-1" });

function automaticas(n: number, over: Partial<Linha> = {}): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    organization_id: ORG,
    contact_id: CONTATO,
    direction: "outbound" as const,
    created_at: minutosAntes(1 + (i % 50)),
    metadata: { ...daAutomacao },
    ...over,
  }));
}

describe("metadataDeOrigemAutomacao", () => {
  it("marca a execução e o ponteiro em metadata.origem_automacao", () => {
    expect(daAutomacao).toEqual({ origem_automacao: { enrollment_id: "enr-1", pointer_id: "ptr-1" } });
    expect(metadataDeOrigemAutomacao({ enrollmentId: "e" })).toEqual({
      origem_automacao: { enrollment_id: "e", pointer_id: null },
    });
  });
});

describe("decidirTeto", () => {
  it("29 cabe mais uma; 30 não", () => {
    expect(TETO_DE_MENSAGENS_POR_HORA).toBe(30);
    expect(decidirTeto(29)).toEqual({ pode: true, enviadasNaUltimaHora: 29 });
    expect(decidirTeto(30)).toEqual({ pode: false, enviadasNaUltimaHora: 30, motivo: MOTIVO_TETO_EXCEDIDO });
    expect(MOTIVO_TETO_EXCEDIDO).toBe("limite de 30 mensagens por hora");
  });
});

describe("podeEnviarMensagemAutomatica", () => {
  it("29 automáticas na última hora: pode", async () => {
    const r = await podeEnviarMensagemAutomatica(bancoCom(automaticas(29)), {
      organizationId: ORG,
      contactIds: [CONTATO],
      agora: AGORA,
    });
    expect(r).toEqual({ pode: true, enviadasNaUltimaHora: 29 });
  });

  it("30 automáticas na última hora: não pode, com o motivo legível", async () => {
    const r = await podeEnviarMensagemAutomatica(bancoCom(automaticas(30)), {
      organizationId: ORG,
      contactIds: [CONTATO],
      agora: AGORA,
    });
    expect(r).toEqual({ pode: false, enviadasNaUltimaHora: 30, motivo: MOTIVO_TETO_EXCEDIDO });
  });

  it("não conta: mais de 1 hora atrás, inbound, sem marca de automação, outro contato, outra organização", async () => {
    const linhas = [
      ...automaticas(29),
      ...automaticas(5, { created_at: minutosAntes(61) }),
      ...automaticas(5, { direction: "inbound" }),
      ...automaticas(5, { metadata: {} }),
      ...automaticas(5, { contact_id: "contato-2" }),
      ...automaticas(5, { organization_id: "org-b" }),
    ];
    const r = await podeEnviarMensagemAutomatica(bancoCom(linhas), {
      organizationId: ORG,
      contactIds: [CONTATO],
      agora: AGORA,
    });
    expect(r).toEqual({ pode: true, enviadasNaUltimaHora: 29 });
  });

  it("falha de leitura fecha: não envia sem saber a conta", async () => {
    const r = await podeEnviarMensagemAutomatica(bancoCom([], { message: "timeout" }), {
      organizationId: ORG,
      contactIds: [CONTATO],
      agora: AGORA,
    });
    expect(r).toEqual({ pode: false, enviadasNaUltimaHora: null, motivo: MOTIVO_TETO_INDISPONIVEL });
  });
});
