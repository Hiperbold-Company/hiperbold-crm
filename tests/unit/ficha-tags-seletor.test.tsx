import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { Lead } from "@/lib/types/leads";

/**
 * As TAGS DO NEGÓCIO na ficha: a mesma lista de etiquetas da empresa que o Inbox
 * usa para o contato (vocabulário, cor, grupos, busca, criar nova), mas aqui o
 * alvo é `crm_leads.tags`. Desde a junção com o upstream (04/11/2026, #2979 do autor) a
 * etiqueta do negócio GRAVA NA HORA, pelo mesmo `ContactTagsEditor` do Inbox, e fica fora do
 * "Salvar" da ficha (decisão da junção: regra do upstream). Antes ela entrava no estado do
 * formulário e ia no "Salvar".
 */
const mutateAsync = vi.fn(async () => ({}));
const mutate = vi.fn();
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync, mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Os produtos do negócio (migration 0972) têm teste próprio (`ficha-produtos-do-negocio.test.tsx`);
// aqui a seção sai da ficha para este arquivo continuar falando só do que fala.
vi.mock("@/components/kanban/ItensDoNegocio", () => ({ ItensDoNegocio: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useActiveOrg: () => ({ orgId: "org-1" }),
  useFusoDaOrganizacao: () => null,
}));

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));

const VOCABULARIO = [
  { tag: "Google Ads", cor: "#0091ff", grupo: "Origem do lead" },
  { tag: "Novo Paciente", cor: "#ffb224", grupo: "Situação do paciente" },
  { tag: "Dra. Ana", cor: null, grupo: "Profissional parceiro" },
];

function lead(tags: string[]): Lead {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-1",
    title: "Maria — Pós em Gestão",
    description: null,
    value_cents: null,
    tags,
    expected_close_date: null,
    custom_fields: {},
  } as unknown as Lead;
}

function monta(tags: string[]) {
  get.mockImplementation(async (url: string) => {
    if (url === "/api/v1/tags/para-escolher") return { data: VOCABULARIO };
    throw new Error(`rota inesperada: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeadFieldsForm lead={lead(tags)} pipelineId="p" />
    </QueryClientProvider>,
  );
}

const espera = { timeout: 5000 };
const salvar = () => userEvent.click(screen.getByRole("button", { name: /Salvar/ }));
const LEAD_ID = "11111111-1111-4111-8111-111111111111";
/** O que a gravação na hora mandou para o negócio, na ordem. */
const gravadas = () =>
  (mutate.mock.calls as unknown as [{ leadId: string; patch: { tags: string[] } }][]).map(
    ([arg]) => arg,
  );

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("ficha do negócio — seletor de etiquetas", () => {
  it("mostra a lista da empresa e marca as que o negócio já tem (pela chave, sem caixa)", async () => {
    monta(["google ads"]);
    const google = await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    expect((google as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Novo Paciente" }) as HTMLInputElement).checked).toBe(false);
    expect(get).toHaveBeenCalledWith("/api/v1/tags/para-escolher");
  });

  it("marcar grava na hora no NEGÓCIO, na grafia do cadastro, sem passar pelo Salvar", async () => {
    monta(["vip"]);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Novo Paciente" }, espera));
    // O negócio guarda "Novo Paciente" como cadastrado (o contato é que normaliza).
    expect(gravadas()).toEqual([{ leadId: LEAD_ID, patch: { tags: ["vip", "Novo Paciente"] } }]);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("desmarcar grava na hora sem ela, inclusive a variante em outra caixa", async () => {
    monta(["VIP", "NOVO PACIENTE", "Google Ads"]);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Novo Paciente" }, espera));
    expect(gravadas()).toEqual([{ leadId: LEAD_ID, patch: { tags: ["VIP", "Google Ads"] } }]);
  });

  it("criar etiqueta nova digitando grava na hora e não envia o formulário sozinho", async () => {
    monta([]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao negócio"), "Retorno 2026{Enter}");
    // O Enter do campo de busca não pode submeter a ficha inteira.
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(gravadas()).toEqual([{ leadId: LEAD_ID, patch: { tags: ["Retorno 2026"] } }]);
  });

  it("o Salvar da ficha não reenvia as etiquetas (quem grava é o seletor)", async () => {
    monta(["vip", "recompra"]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await salvar();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const [{ patch }] = mutateAsync.mock.calls[0] as unknown as [{ patch: Record<string, unknown> }];
    expect(patch).not.toHaveProperty("tags");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("não duplica por caixa: digitar a variante de uma etiqueta que o negócio já tem não a repete", async () => {
    monta(["Google Ads"]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao negócio"), "google ads{Enter}");
    for (const { patch } of gravadas()) expect(patch.tags).toEqual(["Google Ads"]);
  });
});
