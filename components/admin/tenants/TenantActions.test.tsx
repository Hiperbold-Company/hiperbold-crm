/**
 * Excluir só existe para o tenant suspenso — e não para o suspenso por
 * COBRANÇA: excluí-lo deixaria a assinatura cobrando no provedor. O servidor
 * recusa do mesmo jeito (409 `exclusao_com_cobranca_pendente`); a tela não
 * deixa excluir e diz por quê.
 *
 * Hiperbold: o botão é "Excluir organização" (abre `ExcluirOrganizacaoDialog`),
 * fica DESABILITADO com o motivo em vez de sumir, e também fica desabilitado no
 * meio da régua de cobrança própria (contrato atrasada ou suspensa), lida em
 * `GET /api/v1/admin/tenants/[id]/exclusao`. A rede é a fronteira do teste.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

vi.mock("./SuspendDialog", () => ({ SuspendDialog: () => null }));
vi.mock("./ReactivateDialog", () => ({ ReactivateDialog: () => null }));
vi.mock("./DeleteTenantDialog", () => ({ DeleteTenantDialog: () => null }));
vi.mock("./EditTenantDialog", () => ({ EditTenantDialog: () => null }));
vi.mock("./ExcluirOrganizacaoDialog", () => ({ ExcluirOrganizacaoDialog: () => null }));
vi.mock("@/components/admin/ImpersonateButton", () => ({ ImpersonateButton: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TenantActions } from "./TenantActions";

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: null,
  cnpj: null,
  status: "suspended",
  onboarded_at: null,
  suspended_at: "2026-10-01T12:00:00.000Z",
  suspended_kind: "administrativa",
  created_at: "2026-01-01T12:00:00.000Z",
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
const COUNTS = {} as TenantCounts;
const EXPLICACAO = /não pode ser excluída enquanto houver cobrança pendente/;
const NA_REGUA = "Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.";

let resposta: { status: number; corpo: unknown };
const fetchFalso = vi.fn(async () =>
  new Response(JSON.stringify(resposta.corpo), {
    status: resposta.status,
    headers: { "content-type": "application/json" },
  }),
);

beforeEach(() => {
  resposta = { status: 200, corpo: { data: { liberada: true } } };
  fetchFalso.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => vi.unstubAllGlobals());

function renderizar(org: TenantOrganization) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TenantActions organization={org} counts={COUNTS} />
    </QueryClientProvider>,
  );
}

describe("TenantActions — excluir", () => {
  it("suspensão administrativa, sem régua em curso: o botão habilita", async () => {
    renderizar(ORG);
    await waitFor(() => expect(screen.getByTestId("excluir-organizacao")).toBeEnabled());
    expect(screen.queryByText(EXPLICACAO)).toBeNull();
    expect(fetchFalso).toHaveBeenCalledWith(
      `/api/v1/admin/tenants/${ORG.id}/exclusao`,
      expect.anything(),
    );
  });

  it("suspensão sem tipo (nula) vale como administrativa", async () => {
    renderizar({ ...ORG, suspended_kind: null });
    await waitFor(() => expect(screen.getByTestId("excluir-organizacao")).toBeEnabled());
  });

  it("suspensão por cobrança: botão desabilitado, com a explicação", () => {
    renderizar({ ...ORG, suspended_kind: "cobranca" });
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
    expect(screen.getByText(EXPLICACAO)).toBeInTheDocument();
  });

  it("Hiperbold: régua de cobrança em curso: botão desabilitado com o motivo", async () => {
    resposta = {
      status: 200,
      corpo: {
        data: { liberada: false, codigo: "exclusao_na_regua_de_cobranca", mensagem: NA_REGUA, estado: "suspensa" },
      },
    };
    renderizar(ORG);
    expect(await screen.findByText(NA_REGUA)).toBeInTheDocument();
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
  });

  it("Hiperbold: enquanto confere a régua, e se a conferência falha, o botão não habilita", async () => {
    resposta = { status: 500, corpo: { error: { code: "internal_error", message: "x" } } };
    renderizar(ORG);
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
    expect(await screen.findByText(/Não foi possível conferir a cobrança/)).toBeInTheDocument();
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
  });

  it("tenant ativo: desabilitado com 'Suspenda antes de excluir', sem perguntar a régua", () => {
    renderizar({ ...ORG, status: "active", suspended_at: null, suspended_kind: null });
    expect(screen.getByTestId("excluir-organizacao")).toBeDisabled();
    expect(screen.getByText("Suspenda antes de excluir")).toBeInTheDocument();
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
