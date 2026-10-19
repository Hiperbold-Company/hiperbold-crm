import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { Lead } from "@/lib/types/leads";

/**
 * A FICHA em duas categorias: "Dados do lead" primeiro, "Rastreamento" depois.
 * Mocka-se só a gravação (a mutação) — o que se prova é o que o usuário vê e o
 * que sai no Salvar.
 */
const mutateAsync = vi.fn(async () => ({}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const LEAD = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Maria — Pós em Gestão",
  description: null,
  value_cents: null,
  tags: [],
  expected_close_date: null,
  custom_fields: { empresa: "ACME", utm_source: "google", gclid: "abc123" },
} as unknown as Lead;

const DEF = (key: string, label: string, extra: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  key,
  label,
  type: "text",
  ...extra,
});

// Ordem do FUNIL propositalmente misturada: o agrupamento é da tela, não da ordem de cadastro.
const CAMPOS: CustomFieldDef[] = [
  DEF("utm_source", "UTM Source"),
  DEF("empresa", "Empresa"),
  DEF("gclid", "GCLID"),
  DEF("cargo", "Cargo"),
];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function blocos(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-bloco-de-campos]")];
}

describe("campos do funil na ficha", () => {
  it("mostra Dados do lead ANTES de Rastreamento, mesmo com o funil em outra ordem", () => {
    const { container } = render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={CAMPOS} />);
    expect(blocos(container).map((b) => b.dataset.blocoDeCampos)).toEqual(["dados", "rastreamento"]);
    expect(within(blocos(container)[0]!).getByText("Dados do lead")).toBeInTheDocument();
    expect(within(blocos(container)[1]!).getByText(/Rastreamento/)).toBeInTheDocument();
  });

  it("Dados do lead mostra os campos da pessoa; utm e gclid não aparecem ali", () => {
    const { container } = render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={CAMPOS} />);
    const dados = blocos(container)[0]!;
    expect(within(dados).getByLabelText("Empresa")).toHaveValue("ACME");
    expect(within(dados).getByLabelText("Cargo")).toHaveValue("");
    expect(within(dados).queryByLabelText("UTM Source")).not.toBeInTheDocument();
    expect(within(dados).queryByLabelText("GCLID")).not.toBeInTheDocument();
  });

  it("Rastreamento nasce RECOLHIDO, diz quantos campos estão preenchidos e abre ao clicar", async () => {
    const { container } = render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={CAMPOS} />);
    const rastreio = blocos(container)[1]!;
    const botao = within(rastreio).getByRole("button", { name: /Rastreamento/ });
    expect(botao).toHaveAttribute("aria-expanded", "false");
    expect(botao).toHaveTextContent("2/2 preenchidos");
    expect(screen.queryByLabelText("UTM Source")).not.toBeInTheDocument();

    await userEvent.click(botao);
    expect(botao).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("UTM Source")).toHaveValue("google");
    expect(screen.getByLabelText("GCLID")).toHaveValue("abc123");
  });

  it("campo de rastreamento continua EDITÁVEL, e o Salvar leva os dois blocos (inclusive o recolhido)", async () => {
    render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={CAMPOS} />);
    // Edita só um campo de Dados com o Rastreamento recolhido: os valores de utm não podem se perder.
    await userEvent.type(screen.getByLabelText("Cargo"), "Diretora");
    await userEvent.click(screen.getByRole("button", { name: /Rastreamento/ }));
    const utm = screen.getByLabelText("UTM Source");
    await userEvent.clear(utm);
    await userEvent.type(utm, "meta");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const arg = (mutateAsync.mock.calls[0] as unknown as [{ patch: { custom_fields: Record<string, unknown> } }])[0];
    expect(arg.patch.custom_fields).toMatchObject({
      empresa: "ACME",
      cargo: "Diretora",
      utm_source: "meta",
      gclid: "abc123",
    });
  });

  it("bloco vazio não aparece: sem campo de rastreamento no funil, só Dados do lead", () => {
    const { container } = render(
      <LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={[DEF("empresa", "Empresa")]} />,
    );
    expect(blocos(container).map((b) => b.dataset.blocoDeCampos)).toEqual(["dados"]);
    expect(screen.queryByText(/Rastreamento/)).not.toBeInTheDocument();
  });

  it("funil só com rastreamento: não inventa um bloco 'Dados do lead' vazio", () => {
    const { container } = render(
      <LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={[DEF("utm_source", "UTM Source")]} />,
    );
    expect(blocos(container).map((b) => b.dataset.blocoDeCampos)).toEqual(["rastreamento"]);
    expect(screen.queryByText("Dados do lead")).not.toBeInTheDocument();
  });

  it("funil sem campo nenhum: nenhum bloco", () => {
    const { container } = render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={[]} />);
    expect(blocos(container)).toHaveLength(0);
  });

  it("o grupo DECLARADO vence a inferência pela chave", () => {
    const { container } = render(
      <LeadFieldsForm
        lead={LEAD}
        pipelineId="p"
        fieldDefs={[
          DEF("utm_source", "UTM Source", { grupo: "dados" }),
          DEF("empresa", "Empresa", { grupo: "rastreamento" }),
        ]}
      />,
    );
    const [dados, rastreio] = blocos(container);
    expect(within(dados!).getByLabelText("UTM Source")).toBeInTheDocument();
    expect(within(rastreio!).getByRole("button", { name: /Rastreamento/ })).toBeInTheDocument();
  });

  it("Rastreamento com campo OBRIGATÓRIO abre sozinho: não se esconde o que o funil exige", () => {
    render(
      <LeadFieldsForm
        lead={LEAD}
        pipelineId="p"
        fieldDefs={[DEF("empresa", "Empresa"), DEF("utm_source", "UTM Source", { required: true })]}
      />,
    );
    expect(screen.getByLabelText(/UTM Source/)).toBeInTheDocument();
  });

  it("Rastreamento abre sozinho também quando o funil exige o campo por etapa, ganho ou perda", () => {
    for (const obrigatorio_em of [{ etapas: ["e1"] }, { ao_ganhar: true }, { ao_perder: true }]) {
      cleanup();
      render(
        <LeadFieldsForm
          lead={LEAD}
          pipelineId="p"
          fieldDefs={[DEF("empresa", "Empresa"), DEF("utm_source", "UTM Source", { obrigatorio_em })]}
        />,
      );
      expect(screen.getByLabelText(/UTM Source/), JSON.stringify(obrigatorio_em)).toBeInTheDocument();
    }
  });

  it("trocar de negócio recalcula: o bloco volta a recolher (ou a abrir) conforme o NOVO funil", async () => {
    const defs = [DEF("empresa", "Empresa"), DEF("utm_source", "UTM Source")];
    const { rerender } = render(<LeadFieldsForm lead={LEAD} pipelineId="p" fieldDefs={defs} />);
    await userEvent.click(screen.getByRole("button", { name: /Rastreamento/ }));
    expect(screen.getByLabelText("UTM Source")).toBeInTheDocument();
    const outro = { ...LEAD, id: "99999999-9999-4999-8999-999999999999" } as Lead;
    rerender(<LeadFieldsForm lead={outro} pipelineId="p" fieldDefs={defs} />);
    expect(screen.queryByLabelText("UTM Source")).not.toBeInTheDocument();
  });
});
