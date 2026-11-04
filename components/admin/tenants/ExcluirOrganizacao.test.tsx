/**
 * "Excluir organização" no painel de tenants: só aparece (ou só habilita) para tenant SUSPENSO, o botão
 * "Excluir agora" só habilita com o slug exato, e cada botão chama a ação certa da tela de Exclusões.
 * As ações do servidor são o limite do teste (já cobertas em tests/unit/exclusao-*.test.ts): aqui vale o que
 * quem opera vê e clica.
 *
 * Hiperbold: a régua de cobrança própria (`GET /api/v1/admin/tenants/[id]/exclusao`, a rede é a fronteira) bloqueia
 * "Programar" e "Excluir agora" enquanto o contrato está atrasado ou suspenso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const acoes = vi.hoisted(() => ({
  situacao: vi.fn(),
  programar: vi.fn(),
  cancelar: vi.fn(),
  excluir: vi.fn(),
}));
vi.mock("@/app/actions/admin/exclusoes", () => ({
  situacaoDaExclusaoDaOrganizacao: acoes.situacao,
  programarExclusao: acoes.programar,
  cancelarExclusao: acoes.cancelar,
  excluirAgora: acoes.excluir,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/admin/ImpersonateButton", () => ({ ImpersonateButton: () => null }));

import { toast } from "sonner";

import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

import { ExcluirOrganizacaoDialog } from "./ExcluirOrganizacaoDialog";
import { TenantActions } from "./TenantActions";
import { TenantsTable } from "./TenantsTable";

const ORG = "11111111-2222-4333-8444-555555555555";
const organizacao = { id: ORG, slug: "acme-ltda", displayName: "Acme Ltda" };

function comProvider(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const SEM_PROGRAMACAO = { ok: true, programada: null, dataPadrao: "2027-01-18", diasDeGuarda: 90 };
const NA_REGUA = "Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.";
const REGUA_EM_CURSO = {
  data: { liberada: false, codigo: "exclusao_na_regua_de_cobranca", mensagem: NA_REGUA, estado: "suspensa" },
};

let regua: unknown;
const fetchFalso = vi.fn(async () =>
  new Response(JSON.stringify(regua), { status: 200, headers: { "content-type": "application/json" } }),
);

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  regua = { data: { liberada: true } };
  vi.stubGlobal("fetch", fetchFalso);
  acoes.situacao.mockResolvedValue(SEM_PROGRAMACAO);
  acoes.programar.mockResolvedValue({ ok: true });
  acoes.cancelar.mockResolvedValue({ ok: true });
  acoes.excluir.mockResolvedValue({ ok: true });
});

describe("TenantActions (página do tenant)", () => {
  const COUNTS = {} as TenantCounts;
  function org(status: TenantOrganization["status"]): TenantOrganization {
    return {
      id: ORG,
      slug: "acme-ltda",
      display_name: "Acme Ltda",
      legal_name: null,
      cnpj: null,
      status,
      onboarded_at: "2026-01-01T00:00:00.000Z",
      suspended_at: status === "suspended" ? "2026-10-01T00:00:00.000Z" : null,
      suspended_kind: status === "suspended" ? "administrativa" : null,
      created_at: "2026-01-01T00:00:00.000Z",
      settings: null,
      country: null,
      timezone: null,
      locale: null,
      currency: null,
      media_retention_days: null,
      media_retention_enforced: true,
      dpo_email: null,
      privacy_policy_url: null,
    };
  }

  it("tenant ativo: o botão existe desabilitado, com a dica 'Suspenda antes de excluir'", () => {
    render(comProvider(<TenantActions organization={org("active")} counts={COUNTS} />));
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
    expect(screen.getByText("Suspenda antes de excluir")).toBeInTheDocument();
  });

  it("tenant suspenso: o botão habilita e abre o modal com as duas opções", async () => {
    render(comProvider(<TenantActions organization={org("suspended")} counts={COUNTS} />));
    const botao = screen.getByTestId("excluir-organizacao");
    await waitFor(() => expect(botao).toBeEnabled());
    await userEvent.click(botao);
    expect(await screen.findByTestId("programar-exclusao-da-organizacao")).toBeInTheDocument();
    expect(screen.getByTestId("excluir-organizacao-agora")).toBeInTheDocument();
  });

  it("Hiperbold: tenant suspenso no meio da régua de cobrança: botão desabilitado com o motivo", async () => {
    regua = REGUA_EM_CURSO;
    render(comProvider(<TenantActions organization={org("suspended")} counts={COUNTS} />));
    expect(await screen.findByText(NA_REGUA)).toBeInTheDocument();
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
  });

  it("tenant redigido: não oferece excluir", () => {
    render(comProvider(<TenantActions organization={org("redacted")} counts={COUNTS} />));
    expect(screen.queryByTestId("excluir-organizacao")).not.toBeInTheDocument();
  });
});

describe("TenantsTable (lista)", () => {
  const linha = (id: string, status: string): AdminTenantRow => ({
    id,
    slug: `slug-${id}`,
    display_name: `Org ${id}`,
    legal_name: null,
    cnpj: null,
    status,
    onboarded_at: "2026-01-01T00:00:00.000Z",
    suspended_at: status === "suspended" ? "2026-10-01T00:00:00.000Z" : null,
    suspended_kind: null,
    created_at: "2026-01-01T00:00:00.000Z",
    user_count: null,
    conversations_count: null,
  });

  function tabela(linhas: AdminTenantRow[]) {
    return comProvider(
      <TenantsTable data={linhas} hasNextPage={false} isFetchingNextPage={false} onLoadMore={() => undefined} />,
    );
  }

  it("a ação 'Excluir organização' aparece só na linha do tenant suspenso", () => {
    render(tabela([linha("a", "active"), linha("b", "suspended"), linha("c", "redacted")]));
    expect(screen.getByTestId("excluir-organizacao-b")).toBeInTheDocument();
    expect(screen.queryByTestId("excluir-organizacao-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("excluir-organizacao-c")).not.toBeInTheDocument();
  });

  it("clicar na linha suspensa abre o modal daquele tenant", async () => {
    render(tabela([linha("b", "suspended")]));
    await userEvent.click(screen.getByTestId("excluir-organizacao-b"));
    expect(await screen.findByTestId("excluir-organizacao-dialog")).toBeInTheDocument();
    expect(acoes.situacao).toHaveBeenCalledWith({ organizationId: "b" });
  });
});

describe("ExcluirOrganizacaoDialog", () => {
  function abrir(extra: { onExcluida?: () => void } = {}) {
    const onClose = vi.fn();
    render(comProvider(<ExcluirOrganizacaoDialog open onClose={onClose} organizacao={organizacao} {...extra} />));
    return { onClose };
  }

  it("mostra a data que vai valer (regra padrão) e programa por ela", async () => {
    abrir();
    expect(await screen.findByTestId("data-que-vai-valer")).toHaveTextContent("18/01/2027");
    expect(screen.getByTestId("data-que-vai-valer")).toHaveTextContent("90 dias de guarda");
    await userEvent.click(screen.getByTestId("programar-exclusao-da-organizacao"));
    await waitFor(() => expect(acoes.programar).toHaveBeenCalledWith({ organizationId: ORG, data: "2027-01-18" }));
    expect(toast.success).toHaveBeenCalledWith("Exclusão programada.");
    expect(acoes.excluir).not.toHaveBeenCalled();
  });

  it("'Excluir agora' só habilita com o slug exato e chama excluirAgora com o slug", async () => {
    const onExcluida = vi.fn();
    const { onClose } = abrir({ onExcluida });
    await screen.findByTestId("data-que-vai-valer");
    const botao = screen.getByTestId("excluir-organizacao-agora");
    const campo = screen.getByTestId("excluir-organizacao-slug");

    expect(botao).toBeDisabled();
    await userEvent.type(campo, "acme");
    expect(botao).toBeDisabled();
    await userEvent.clear(campo);
    await userEvent.type(campo, "ACME-LTDA");
    expect(botao).toBeDisabled();
    await userEvent.clear(campo);
    await userEvent.type(campo, "acme-ltda");
    await waitFor(() => expect(botao).toBeEnabled());

    await userEvent.click(botao);
    await waitFor(() =>
      expect(acoes.excluir).toHaveBeenCalledWith({ organizationId: ORG, slugDigitado: "acme-ltda", confirmar: true }),
    );
    expect(toast.success).toHaveBeenCalledWith("Organização excluída.");
    expect(onClose).toHaveBeenCalled();
    expect(onExcluida).toHaveBeenCalled();
    expect(acoes.programar).not.toHaveBeenCalled();
  });

  it("recusa do servidor ao excluir: mostra o erro e não dá o tenant por excluído", async () => {
    acoes.excluir.mockResolvedValue({ ok: false, error: "Suspenda a organização antes de excluir." });
    const onExcluida = vi.fn();
    abrir({ onExcluida });
    await screen.findByTestId("data-que-vai-valer");
    await userEvent.type(screen.getByTestId("excluir-organizacao-slug"), "acme-ltda");
    await userEvent.click(screen.getByTestId("excluir-organizacao-agora"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Suspenda a organização antes de excluir."));
    expect(onExcluida).not.toHaveBeenCalled();
  });

  it("Hiperbold: régua de cobrança em curso: mostra o motivo e não deixa programar nem excluir", async () => {
    regua = REGUA_EM_CURSO;
    abrir();
    expect(await screen.findByTestId("exclusao-bloqueada-pela-regua")).toHaveTextContent(NA_REGUA);
    await screen.findByTestId("data-que-vai-valer");
    await userEvent.type(screen.getByTestId("excluir-organizacao-slug"), "acme-ltda");
    expect(screen.getByTestId("excluir-organizacao-agora")).toBeDisabled();
    expect(screen.getByTestId("programar-exclusao-da-organizacao")).toBeDisabled();
    expect(acoes.excluir).not.toHaveBeenCalled();
    expect(acoes.programar).not.toHaveBeenCalled();
  });

  it("Hiperbold: régua em curso com exclusão já programada: cancelar continua possível", async () => {
    regua = REGUA_EM_CURSO;
    acoes.situacao.mockResolvedValue({
      ...SEM_PROGRAMACAO,
      programada: { excluirEm: "2027-02-10T05:00:00.000Z", origem: "automatica" },
    });
    abrir();
    await screen.findByTestId("exclusao-bloqueada-pela-regua");
    await userEvent.click(await screen.findByTestId("cancelar-exclusao-programada"));
    await waitFor(() => expect(acoes.cancelar).toHaveBeenCalledWith({ organizationId: ORG }));
  });

  it("Hiperbold: régua terminou (liberada): sem aviso, a exclusão segue habilitada pelo slug", async () => {
    abrir();
    await screen.findByTestId("data-que-vai-valer");
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    await userEvent.type(screen.getByTestId("excluir-organizacao-slug"), "acme-ltda");
    await waitFor(() => expect(screen.getByTestId("excluir-organizacao-agora")).toBeEnabled());
    expect(screen.queryByTestId("exclusao-bloqueada-pela-regua")).toBeNull();
  });

  it("já programada: mostra a data e o cancelar chama cancelarExclusao", async () => {
    acoes.situacao.mockResolvedValue({
      ...SEM_PROGRAMACAO,
      programada: { excluirEm: "2027-02-10T05:00:00.000Z", origem: "manual" },
    });
    abrir();
    expect(await screen.findByTestId("exclusao-ja-programada")).toHaveTextContent("10/02/2027");
    expect(screen.getByTestId("programar-exclusao-da-organizacao")).toHaveTextContent("Reprogramar exclusão");
    await userEvent.click(screen.getByTestId("cancelar-exclusao-programada"));
    await waitFor(() => expect(acoes.cancelar).toHaveBeenCalledWith({ organizationId: ORG }));
    expect(toast.success).toHaveBeenCalledWith("Exclusão cancelada.");
  });
});
