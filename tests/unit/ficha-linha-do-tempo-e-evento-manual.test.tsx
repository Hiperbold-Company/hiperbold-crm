import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadTimeline } from "@/components/kanban/LeadTimeline";
import { RegistrarEvento, paraCampoDeData } from "@/components/kanban/RegistrarEvento";
import type { TimelineItemView } from "@/lib/types/contacts";

const post = vi.fn(async () => ({ data: { id: "novo" } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...a: unknown[]) => post(...(a as [])) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const LEAD = "11111111-1111-4111-8111-111111111111";
const IRMAO = "22222222-2222-4222-8222-222222222222";

const item = (over: Partial<TimelineItemView> & { id: string }): TimelineItemView => ({
  organization_id: "o",
  lead_id: LEAD,
  contact_id: "c",
  source_module: "kanban",
  source_id: null,
  type: "stage_changed",
  payload: {},
  metadata: {},
  performed_at: "2026-10-19T12:00:00.000Z",
  performed_by_user_id: "u",
  actor_kind: "user",
  reason: "Movido de Novo para Proposta",
  actor_user_name: "Ana",
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function linhas() {
  return render(
    <LeadTimeline
      leadId={LEAD}
      chegouAoVivo={new Set()}
      isLoading={false}
      isError={false}
      itens={[
        item({
          id: "manual",
          type: "note",
          source_module: "manual",
          reason: "Registro manual",
          payload: { subtype: "ligacao", text: "Ligou pedindo proposta.\nRetornar na terça." },
        }),
        item({
          id: "irmao",
          lead_id: IRMAO,
          negocio_titulo: "Pós em Dados",
          funil_nome: "FUTURO 2027",
          performed_at: "2026-10-18T09:00:00.000Z",
        }),
        item({ id: "proprio", performed_at: "2026-10-17T09:00:00.000Z" }),
      ]}
    />,
  );
}

describe("linha do tempo da ficha = a do CONTATO", () => {
  it("evento de OUTRO negócio diz de qual funil e negócio veio", () => {
    const { container } = linhas();
    const origens = [...container.querySelectorAll("[data-origem-do-negocio]")];
    expect(origens).toHaveLength(1);
    expect(origens[0]).toHaveTextContent("FUTURO 2027 · Pós em Dados");
  });

  it("evento do negócio ABERTO não repete a origem", () => {
    linhas();
    const proprio = screen.getAllByText("Movido de Novo para Proposta");
    expect(proprio).toHaveLength(2); // o do irmão e o do próprio
    // só um dos dois <li> tem origem
    expect(document.querySelectorAll("[data-origem-do-negocio]")).toHaveLength(1);
  });
});

describe("evento manual na linha do tempo", () => {
  it("mostra rótulo do tipo, texto COMPLETO com as quebras, autor e a marca de registro manual", () => {
    const { container } = linhas();
    const li = container.querySelector<HTMLElement>('[data-evento-manual="ligacao"]')!;
    expect(li).toBeTruthy();
    expect(within(li).getByText("Ligação")).toBeInTheDocument();
    const texto = within(li).getByText(/Ligou pedindo proposta/);
    expect(texto.textContent).toBe("Ligou pedindo proposta.\nRetornar na terça.");
    expect(texto.className).toContain("whitespace-pre-wrap");
    expect(li).toHaveTextContent("Ana");
    expect(li).toHaveTextContent("registro manual");
    // não mostra o 'Anotação' genérico nem o `reason` técnico no lugar do texto
    expect(within(li).queryByText("Anotação")).not.toBeInTheDocument();
    expect(within(li).queryByText("Registro manual")).not.toBeInTheDocument();
  });

  it("texto longo (2000 caracteres) não é truncado", () => {
    const longo = "a".repeat(2000);
    const { container } = render(
      <LeadTimeline
        leadId={LEAD}
        chegouAoVivo={new Set()}
        isLoading={false}
        isError={false}
        itens={[
          item({
            id: "m",
            type: "note",
            source_module: "manual",
            payload: { subtype: "nota", text: longo },
          }),
        ]}
      />,
    );
    expect(container.querySelector('[data-evento-manual="nota"]')).toHaveTextContent(longo);
  });
});

describe("Carregar mais e registro retroativo na linha", () => {
  const base = { leadId: LEAD, chegouAoVivo: new Set<string>(), isLoading: false, isError: false };

  it("com mais história no servidor mostra 'Carregar mais' e chama o carregamento", async () => {
    const mais = vi.fn();
    render(<LeadTimeline {...base} itens={[item({ id: "a" })]} temMais aoCarregarMais={mais} />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(mais).toHaveBeenCalledTimes(1);
  });

  it("sem mais história não mostra o botão; carregando, ele fica desabilitado", () => {
    const { rerender } = render(<LeadTimeline {...base} itens={[item({ id: "a" })]} />);
    expect(screen.queryByRole("button", { name: /Carregar mais/ })).not.toBeInTheDocument();
    rerender(<LeadTimeline {...base} itens={[item({ id: "a" })]} temMais carregandoMais />);
    expect(screen.getByRole("button", { name: "Carregando…" })).toBeDisabled();
  });

  const manual = (extra: Partial<TimelineItemView>) =>
    item({
      id: "m",
      type: "note",
      source_module: "manual",
      payload: { subtype: "reuniao", text: "Alinhamento" },
      ...extra,
    });

  it("evento manual RETROATIVO (mais de 1h) mostra também 'registrado em'", () => {
    const { container } = render(
      <LeadTimeline
        {...base}
        itens={[manual({ performed_at: "2026-10-01T10:00:00Z", created_at: "2026-10-19T12:00:00Z" })]}
      />,
    );
    expect(container.querySelector("[data-registrado-em]")).toHaveTextContent("registrado em");
  });

  it("evento retroativo recém-chegado leva 'novo', não 'agora' (a data dele é de semanas atrás)", () => {
    render(
      <LeadTimeline
        {...base}
        chegouAoVivo={new Set(["m"])}
        itens={[manual({ performed_at: "2026-09-10T15:00:00Z", created_at: "2026-10-19T12:00:00Z" })]}
      />,
    );
    expect(screen.getByText("novo")).toBeInTheDocument();
    expect(screen.queryByText("agora")).not.toBeInTheDocument();
  });

  it("evento registrado na hora que chega ao vivo continua com 'agora'", () => {
    render(
      <LeadTimeline
        {...base}
        chegouAoVivo={new Set(["m"])}
        itens={[manual({ performed_at: "2026-10-19T11:50:00Z", created_at: "2026-10-19T12:00:00Z" })]}
      />,
    );
    expect(screen.getByText("agora")).toBeInTheDocument();
  });

  it("evento registrado na hora NÃO repete a data", () => {
    const { container } = render(
      <LeadTimeline
        {...base}
        itens={[manual({ performed_at: "2026-10-19T11:50:00Z", created_at: "2026-10-19T12:00:00Z" })]}
      />,
    );
    expect(container.querySelector("[data-registrado-em]")).toBeNull();
  });
});

describe("RegistrarEvento (formulário)", () => {
  function monta() {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RegistrarEvento leadId={LEAD} />
      </QueryClientProvider>,
    );
  }

  it("abre com tipo Nota e data/hora de agora", async () => {
    monta();
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    const quando = screen.getByLabelText("Data e hora") as HTMLInputElement;
    const agora = Date.now();
    expect(Math.abs(new Date(quando.value).getTime() - agora)).toBeLessThan(2 * 60_000);
    expect(screen.getByRole("combobox", { name: "Tipo" })).toHaveTextContent("Nota");
  });

  it("texto vazio: mostra o erro e NÃO chama a API", async () => {
    monta();
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    await userEvent.click(screen.getByRole("button", { name: "Registrar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Escreva o que aconteceu.");
    expect(post).not.toHaveBeenCalled();
  });

  it("data no futuro: recusa no formulário e NÃO chama a API", async () => {
    monta();
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    await userEvent.type(screen.getByLabelText("O que aconteceu"), "Reunião marcada");
    const quando = screen.getByLabelText("Data e hora") as HTMLInputElement;
    const amanha = paraCampoDeData(new Date(Date.now() + 24 * 3600_000));
    // `user.type` em datetime-local é frágil no jsdom; troca o valor como o navegador faria.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(quando, { target: { value: amanha } });
    await userEvent.click(screen.getByRole("button", { name: "Registrar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A data do evento não pode ser no futuro.");
    expect(post).not.toHaveBeenCalled();
  });

  it("data no passado vale: envia tipo, texto aparado e a data escolhida em ISO", async () => {
    monta();
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    await userEvent.type(screen.getByLabelText("O que aconteceu"), "  Falei com ela  ");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("Data e hora"), { target: { value: "2026-10-01T14:30" } });
    await userEvent.click(screen.getByRole("button", { name: "Registrar" }));

    expect(post).toHaveBeenCalledTimes(1);
    const [caminho, corpo] = post.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(caminho).toBe(`/api/v1/leads/${LEAD}/activities`);
    expect(corpo).toEqual({
      subtype: "nota",
      text: "Falei com ela",
      occurred_at: new Date("2026-10-01T14:30").toISOString(),
    });
  });

  it("depois de gravar chama onRegistrado com o id do evento (a ficha pagina até ele)", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const onRegistrado = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <RegistrarEvento leadId={LEAD} onRegistrado={onRegistrado} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    await userEvent.type(screen.getByLabelText("O que aconteceu"), "Retroativo");
    await userEvent.click(screen.getByRole("button", { name: "Registrar" }));
    await vi.waitFor(() => expect(onRegistrado).toHaveBeenCalledWith("novo"));
  });

  it("limita o texto a 2000 caracteres e mostra o contador", async () => {
    monta();
    await userEvent.click(screen.getByRole("button", { name: "Registrar evento" }));
    const area = screen.getByLabelText("O que aconteceu") as HTMLTextAreaElement;
    expect(area.maxLength).toBe(2000);
    expect(screen.getByText("0/2000")).toBeInTheDocument();
  });
});
