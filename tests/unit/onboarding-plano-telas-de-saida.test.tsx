/**
 * Telas do passo "Plano" do onboarding que prendiam o cliente (auditoria de 17/10/2026):
 *
 *  - quem foi convidado e NÃO é administrador de uma organização que ainda não pagou vê a quem pedir (nome e
 *    e-mail dos administradores) e tem a saída da conta no cabeçalho do wizard;
 *  - o Pix pendente DENTRO do onboarding não manda para `/app/...` (rota que o cliente sem plano não alcança): usa
 *    "Atualizar", que recarrega a página do passo; fora do onboarding o link "Ver pedido" continua;
 *  - a validade do Pix é lida como horário de São Paulo (testada à parte em `data-do-asaas-fuso-de-sao-paulo`);
 *  - o botão "Trocar forma de pagamento" existe na espera do pagamento.
 */
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  papel: "agent",
  admins: [] as Array<{ nome: string | null; email: string; locale: string | null }>,
  adminsLanca: false,
  poll: { status: "aguardando_pagamento", parou: true } as { status: string | null; parou: boolean; erro?: boolean },
}));

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NUVEMSHOP_ENABLED: false,
    ASAAS_ENABLED: true,
    ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
    ASAAS_API_KEY: "$aact_hmlg_teste",
    ASAAS_WEBHOOK_TOKEN: "",
    ASAAS_WEBHOOK_ID: "",
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "u1", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: h.papel })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { user_metadata: {} } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) b[m] = () => b;
      const ler = () => {
        if (tabela === "billing_settings") return { data: { modo: "bloquear", compra_pelo_cliente: true }, error: null };
        if (tabela === "organizations") return { data: { settings: { billing_inicio: "sem_plano" } }, error: null };
        if (tabela === "billing_contracts") return { data: { status: "suspensa", cycle: null, current_period_end: null }, error: null };
        if (tabela === "billing_orders") return { data: null, error: null };
        throw new Error(`tabela não dublada: ${tabela}`);
      };
      b.maybeSingle = async () => ler();
      b.single = async () => ler();
      return b;
    },
  }),
}));
vi.mock("@/lib/email/conta-e-cobranca/enviar", () => ({
  adminsDaOrganizacao: vi.fn(async () => {
    if (h.adminsLanca) throw new Error("banco fora");
    return h.admins;
  }),
}));
vi.mock("@/app/app/settings/plano/assinar/_dados", () => ({ dadosDaCompraDePlano: async () => ({ planos: [], leituraFalhou: false }) }));
vi.mock("@/app/app/settings/plano/assinar/_passo-a-passo", () => ({ AssinarPlanoPassoAPasso: () => null }));
vi.mock("@/app/onboarding/plano/_aguardando", () => ({ AguardandoPagamento: () => null }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@/app/actions/settings/compraDoPlano", () => ({ trocarFormaDePagamento: vi.fn() }));
vi.mock("@/app/app/settings/plano/_use-poll-pedido", () => ({ usePollDoPedido: () => h.poll }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (t: string) => t }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import PlanoPage from "@/app/onboarding/plano/page";
import { SairDoOnboarding } from "@/app/onboarding/_components/SairDoOnboarding";
import { PixPendente } from "@/app/app/settings/plano/assinar/_pix-pendente";
import { podeCancelarAssinatura } from "@/app/app/settings/plano/_logica-compra";

function texto(no: ReactNode): string {
  if (no === null || no === undefined || typeof no === "boolean") return "";
  if (typeof no === "string" || typeof no === "number") return String(no);
  if (Array.isArray(no)) return no.map(texto).join("");
  const el = no as ReactElement<{ children?: ReactNode; href?: string }>;
  // Componente de função (síncrono): expande, como o React faria.
  if (typeof el.type === "function") return texto((el.type as (p: unknown) => ReactNode)(el.props));
  return `${el.props?.href ?? ""}${texto(el.props?.children)}`;
}

beforeEach(() => {
  h.papel = "agent";
  h.admins = [];
  h.adminsLanca = false;
  h.poll = { status: "aguardando_pagamento", parou: true };
});

describe("/onboarding/plano para quem não é administrador", () => {
  it("diz a QUEM pedir: nome e e-mail dos administradores", async () => {
    h.admins = [
      { nome: "Ana", email: "ana@empresa.test", locale: null },
      { nome: null, email: "dono@empresa.test", locale: null },
    ];
    const t = texto(await PlanoPage({ searchParams: Promise.resolve({}) }));
    expect(t).toContain("Peça a um administrador");
    expect(t).toContain("Ana: ");
    expect(t).toContain("ana@empresa.test");
    expect(t).toContain("dono@empresa.test");
  });

  it("falha na leitura dos administradores não derruba a página: a frase fica, sem a lista", async () => {
    h.adminsLanca = true;
    const t = texto(await PlanoPage({ searchParams: Promise.resolve({}) }));
    expect(t).toContain("Peça a um administrador");
    expect(t).not.toContain("@");
  });
});

describe("a saída da conta no cabeçalho do wizard", () => {
  it("é um formulário com o botão Sair ligado à ação de sair", () => {
    const html = renderToStaticMarkup(<SairDoOnboarding />);
    expect(html).toContain("<form");
    expect(html).toContain('data-testid="sair-da-conta"');
    expect(html).toContain("Sair");
  });
});

describe("Pix pendente", () => {
  const QR = { encodedImage: "AAAA", payload: "00020126", expirationDate: "2026-10-17 23:59:59" } as never;

  it("dentro do onboarding NÃO aponta para /app/...: oferece Atualizar", () => {
    const html = renderToStaticMarkup(<PixPendente pedidoId="p1" qr={QR} depoisDePago={{ href: "/onboarding" }} />);
    expect(html).not.toContain("/app/");
    expect(html).toContain('data-testid="pix-atualizar-pedido"');
  });

  it("fora do onboarding o link Ver pedido continua", () => {
    const html = renderToStaticMarkup(<PixPendente pedidoId="p1" qr={QR} />);
    expect(html).toContain("/app/settings/plano/pedido/p1");
  });

  it("a validade aparece no horário de São Paulo", () => {
    const html = renderToStaticMarkup(<PixPendente pedidoId="p1" qr={QR} depoisDePago={{ href: "/onboarding" }} />);
    expect(html).toContain("17/10/2026, 23:59:59");
    expect(html).toContain("horário de Brasília");
  });

  it("validade ilegível some em vez de mostrar 'Invalid Date'", () => {
    const html = renderToStaticMarkup(
      <PixPendente pedidoId="p1" qr={{ ...(QR as object), expirationDate: "amanhã" } as never} depoisDePago={{ href: "/onboarding" }} />,
    );
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("pix-expira-em");
  });
});

describe("Cancelar assinatura para quem paga sem assinatura no Asaas (Pix, parcelado)", () => {
  const base = {
    habilitado: true,
    erroConfiguracao: null,
    ambiente: "producao" as const,
    assinaturaDoContrato: null,
    pedidos: [],
    agora: new Date("2026-10-17T12:00:00Z"),
  };
  it("o botão aparece com contrato ativo, não cancelado e período pago a frente", () => {
    expect(
      podeCancelarAssinatura({ ...base, contrato: { status: "ativa", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-11-15T03:00:00Z" } }),
    ).toBe(true);
  });
  it("não aparece sem contrato, já cancelado, vencido ou não ativo", () => {
    for (const contrato of [
      null,
      { status: "ativa", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-11-15T03:00:00Z" },
      { status: "ativa", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-10-01T03:00:00Z" },
      { status: "suspensa", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-11-15T03:00:00Z" },
    ]) {
      expect(podeCancelarAssinatura({ ...base, contrato })).toBe(false);
    }
  });
});
