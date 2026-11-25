/**
 * ESTADOS UNIDOS: o país revisado SEM lei geral de proteção de dados (24/11/2026).
 * O que o titular e o encarregado leem não cita lei nenhuma — nem LGPD, nem RGPD,
 * nem o "não declarada (país sem citação revisada)" do país que ninguém revisou.
 * Os mocks e auxiliares são os de `lgpd-texto-segue-o-pais.test.tsx`.
 */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enviados = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);
const banco = vi.hoisted(() => ({ org: {} as Record<string, unknown> }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async (e: { subject: string; html: string; text: string }) => {
    enviados.push(e);
    return { ok: true, id: "m1" };
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
/** Banco falso: `organizations` devolve a linha do teste; toda outra tabela, vazio. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const consulta = (tabela: string): unknown => {
      const q: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then")
              return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
                Promise.resolve({
                  data: tabela === "organizations" ? [banco.org] : [],
                  error: null,
                  count: 0,
                }).then(ok, erro);
            if (prop === "maybeSingle" || prop === "single")
              return async () => ({ data: tabela === "organizations" ? banco.org : null, error: null });
            return () => q;
          },
        },
      );
      return q;
    };
    return { from: consulta, rpc: async () => ({ data: null, error: null }) };
  },
}));

import { PERFIS_DO_PAIS, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { sendExportEmail } from "@/lib/lgpd/email-delivery";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";
import { LgpdExportPdf } from "@/lib/lgpd/pdf-renderer";
import { triggerSlaAlarm, type AlarmThreshold } from "@/lib/lgpd/sla-alarm";
import type { LgpdRequest } from "@/lib/lgpd/types";


const MARCA = {
  nome: "Silva & Filhos",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
} as const;

/** País sintético SEM lei revisada: prova que o ramo não-BR não inventa lei. */
const XISTAO: PerfilDoPais = { ...perfilDoPais("PT"), codigo: "XI", nome: "Xistão", lei: null };

beforeEach(() => {
  enviados.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  PERFIS_DO_PAIS.XI = XISTAO;
});
afterEach(() => {
  vi.useRealTimers();
  delete PERFIS_DO_PAIS.XI;
});

async function emailPara(perfil: PerfilDoPais, fuso?: string) {
  await sendExportEmail({
    to: "titular@x.test",
    requestId: "3f2a9c10-0000-4000-8000-000000000001",
    signedUrl: "https://storage.test/report.pdf?token=abc",
    signedUrlDados: "https://storage.test/data.json?token=abc",
    expiresAt: new Date("2026-10-08T12:00:00.000Z"),
    marca: MARCA,
    perfil,
    fuso,
  });
  return enviados[0]!;
}

const ALARMES: ReadonlyArray<readonly [AlarmThreshold, string]> = [
  ["data_request_d5", "2026-10-01"],
  ["redact_d10", "2026-10-20"],
];

async function alarmesPara(country: string | null, tipo?: string) {
  const saida = [];
  for (const [threshold, due] of ALARMES) {
    enviados.length = 0;
    await triggerSlaAlarm({
      request: {
        id: "22222222-2222-4222-8222-222222222222",
        organization_id: "org-1",
        request_type: tipo ?? (threshold === "data_request_d5" ? "data_request" : "redact"),
        status: "pending",
        attempts: 0,
        received_at: "2026-09-20T12:00:00.000Z",
        due_at: due,
        request_payload: {},
      } as unknown as LgpdRequest,
      threshold,
      organizationDpoEmail: "dpo@x.test",
      organizationName: "Empresa <B>",
      marca: MARCA,
      country,
    });
    saida.push(enviados[0]!);
  }
  return saida;
}

async function dataJson(country: string | null, timezone: string, pais?: string | null) {
  banco.org = {
    legal_name: "Bem Viver LTDA",
    display_name: "Bem Viver",
    dpo_email: "dpo@bv.test",
    country,
    timezone,
  };
  const pedido = {
    organizationId: "org-1",
    requestId: "r1",
    externalCustomerId: null,
    ...(pais === undefined ? {} : { pais }),
  };
  const vazio = await collectExportData({ ...pedido, contactId: null });
  const cheio = await collectExportData({ ...pedido, contactId: "c1" });
  return { vazio, cheio };
}

function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) return textos(el.props.children);
  return [];
}

function pdfDe(
  base: ExportPayload,
  extra: { contato?: Record<string, unknown>; unsignedWarning?: boolean } = {},
): string[] {
  return textos(
    LgpdExportPdf({
      unsignedWarning: extra.unsignedWarning,
      data: {
        ...base,
        generated_at: "2026-10-05T12:34:56.000Z",
        contact: {
          id: "c1",
          full_name: "Ana",
          email: "ana@x.test",
          phone_number: "+5511999998888",
          cpf: "52998224725",
          // Onde a pergunta de roteiro do tipo `cpf` grava: é de lá que o PDF
          // lê o valor que imprime mascarado (issue #2341).
          custom_fields: { cpf: "52998224725" },
          source: "whatsapp",
          created_at: "2026-01-02T03:04:05.000Z",
          is_anonymized: false,
          ...extra.contato,
        } as never,
        consents: [{ scope: "marketing", granted: true, granted_at: "2026-02-03T04:05:06.000Z" } as never],
      },
    }),
  );
}

const US = perfilDoPais("US");

describe("Estados Unidos: nenhuma lei citada", () => {
  it("o data.json não traz citação e marca o país sem lei geral", async () => {
    const { cheio } = await dataJson("US", "America/New_York");
    expect(cheio.lei_citada).toBeNull();
    expect(cheio.sem_lei_geral).toBe(true);
    expect(cheio.lei_rotulo).toBeUndefined();
    expect(JSON.stringify(cheio)).not.toMatch(/LGPD|RGPD|13\.709|2016\/679/);
  });

  it("o PDF não imprime linha de citação nem 'não declarada'", async () => {
    const { cheio } = await dataJson("US", "America/New_York");
    const tudo = pdfDe(cheio).join("\n");
    expect(tudo).not.toMatch(/LGPD|RGPD|13\.709|não declarada|Base legal|Direito exercido/);
    expect(tudo).toContain("Solicitação #");
  });

  it("o PDF rotula o documento pelo TIPO gravado", async () => {
    const { cheio } = await dataJson("US", "America/New_York");
    const tudo = pdfDe(cheio, { contato: { cpf_present: true, document_type: "us_passport" } }).join("\n");
    expect(tudo).toContain("Passaporte americano (US Passport)");
  });

  it("o país sem revisão continua dizendo 'não declarada' (a régua antiga não mudou)", async () => {
    const { cheio } = await dataJson("XI", "UTC");
    expect(pdfDe(cheio).join("\n")).toContain("não declarada (país sem citação revisada)");
  });

  it("o e-mail ao titular não cita lei", async () => {
    const { subject, html, text } = await emailPara(US, "America/New_York");
    expect(`${subject}\n${html}\n${text}`).not.toMatch(/LGPD|RGPD|13\.709|Direito exercido/);
  });

  it("o alarme ao encarregado não promete prazo legal", async () => {
    for (const { subject, html, text } of await alarmesPara("US")) {
      const tudo = `${subject}\n${html}\n${text}`;
      expect(tudo).not.toMatch(/LGPD|RGPD|13\.709|prazo legal/);
      expect(tudo).toContain("The system's internal deadline.");
    }
  });
});
