import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";

/**
 * Tags do CONTATO no Inbox: o editor mostra a LISTA de etiquetas da empresa
 * (vocabulário cadastrado + em uso), agrupada, cada uma uma caixa de marcar.
 *
 * Antes eram no máximo 8 sugestões "em uso nos contatos": uma empresa nova, com
 * 17 etiquetas cadastradas e nenhum contato etiquetado, não via nenhuma e
 * dependia de digitar — e cada operador digitava a sua variação (#852).
 *
 * Mesmo desenho do teste irmão da rota (`tags-para-escolher-rota.test.ts`): aqui
 * a fonte é uma lista pronta no mock da rede; o que se prova é o que a pessoa vê
 * e o que o clique grava.
 */

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1" } }),
}));

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
const mutate = vi.fn();
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));

const ORG = "org-1";

const VOCABULARIO = [
  { tag: "Google Ads", cor: "#0091ff", grupo: "Origem do lead" },
  { tag: "Indicação", cor: "#12a594", grupo: "Origem do lead" },
  { tag: "Novo Paciente", cor: "#ffb224", grupo: "Situação do paciente" },
  { tag: "Dra. Ana", cor: null, grupo: "Profissional parceiro" },
  { tag: "Sem grupo", cor: null, grupo: null },
];

function monta(tags: string[], vocabulario: unknown = VOCABULARIO) {
  get.mockImplementation(async (url: string) => {
    if (url === "/api/v1/tags/para-escolher") return { data: vocabulario };
    throw new Error(`rota inesperada: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContactTagsEditor contactId="c-1" orgId={ORG} tags={tags} />
    </QueryClientProvider>,
  );
}

const espera = { timeout: 5000 };

beforeEach(() => {
  get.mockReset();
  mutate.mockReset();
});

describe("ContactTagsEditor — a lista de etiquetas da empresa", () => {
  it("lê o vocabulário da rota certa e mostra grupos na ordem cadastrada, 'Outras' no fim", async () => {
    monta([]);

    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    // Nada amarra o hook à rota além deste teste: trocar por `/contact-tags`
    // (só nomes em uso) devolveria a lista sem grupo nem cor, com tudo verde.
    expect(get).toHaveBeenCalledWith("/api/v1/tags/para-escolher");

    const grupos = screen.getAllByRole("group", { name: /./ }).filter((g) => g.getAttribute("aria-labelledby"));
    expect(grupos.map((g) => g.textContent)).toEqual([
      "Origem do leadGoogle AdsIndicação",
      "Situação do pacienteNovo Paciente",
      "Profissional parceiroDra. Ana",
      "OutrasSem grupo",
    ]);
  });

  it("empresa nova: etiquetas cadastradas aparecem mesmo sem nenhum contato etiquetado", async () => {
    monta([]);
    const caixas = await screen.findAllByRole("checkbox", {}, espera);
    expect(caixas).toHaveLength(5);
    expect(caixas.every((c) => !(c as HTMLInputElement).checked)).toBe(true);
  });

  it("cada etiqueta com cor mostra a bolinha; sem cor, nada", async () => {
    monta([]);
    const google = (await screen.findByRole("checkbox", { name: "Google Ads" }, espera)).closest("label")!;
    const ponto = google.querySelector("[data-ponto-da-etiqueta]");
    expect(ponto?.getAttribute("style") ?? "").toMatch(/rgb\(0,\s*145,\s*255\)|#0091ff/i);
    const ana = screen.getByRole("checkbox", { name: "Dra. Ana" }).closest("label")!;
    expect(ana.querySelector("[data-ponto-da-etiqueta]")).toBeNull();
  });

  it("marcada = o contato tem; a comparação é pela forma normalizada (VIP/vip)", async () => {
    monta(["novo paciente", "INDICAÇÃO"]);
    const novo = await screen.findByRole("checkbox", { name: "Novo Paciente" }, espera);
    expect((novo as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Indicação" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Google Ads" }) as HTMLInputElement).checked).toBe(false);
  });

  it("marcar grava na hora, na forma normalizada, sem duplicar o que o contato já tem", async () => {
    monta(["vip"]);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Novo Paciente" }, espera));
    // A lista mostra a grafia do cadastro; o contato guarda a chave (a rota
    // normaliza de qualquer jeito: "Novo Paciente" e "novo paciente" são uma tag).
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "novo paciente"] });
  });

  it("desmarcar remove na hora, inclusive a variante em caixa mista", async () => {
    monta(["VIP", "Novo Paciente", "google ads"]);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Novo Paciente" }, espera));
    expect(mutate).toHaveBeenCalledWith({ tags: ["VIP", "google ads"] });
  });

  it("tag que o contato tem e o vocabulário não conhece vira caixa marcada em 'Outras'", async () => {
    monta(["importada"]);
    const caixa = await screen.findByRole("checkbox", { name: "importada" }, espera);
    expect((caixa as HTMLInputElement).checked).toBe(true);
    expect(caixa.closest("[aria-labelledby]")?.textContent).toContain("Outras");
    await userEvent.click(caixa);
    expect(mutate).toHaveBeenCalledWith({ tags: [] });
  });

  it("a lista com rolagem: altura máxima e rolagem vertical", async () => {
    monta([]);
    const lista = (await screen.findByRole("checkbox", { name: "Google Ads" }, espera)).closest(
      '[role="group"][aria-label="Etiquetas da empresa"]',
    )!;
    expect(lista.className).toMatch(/max-h-/);
    expect(lista.className).toMatch(/overflow-y-auto/);
  });
});

describe("ContactTagsEditor — busca e criação", () => {
  it("a busca filtra sem acento e sem caixa, e grupo sem resultado some", async () => {
    monta([]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);

    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "INDICACAO");

    expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual(["Indicação"]);
    expect(screen.queryByText("Situação do paciente")).toBeNull();
    // Existe: não oferece criar.
    expect(screen.queryByRole("button", { name: /Criar etiqueta/ })).toBeNull();
  });

  it("texto que não existe oferece criar, e criar grava a tag normalizada", async () => {
    monta(["vip"]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);

    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "Retorno 2026");
    expect(screen.getByText("Nenhuma etiqueta encontrada.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Criar etiqueta “Retorno 2026”" }));

    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "retorno 2026"] });
  });

  it("Enter cria quando o texto não existe (o caminho de quem digita direto)", async () => {
    monta([]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "nova{Enter}");
    expect(mutate).toHaveBeenCalledWith({ tags: ["nova"] });
  });

  it("não duplica por caixa: digitar a variante de uma tag que o contato já tem não grava", async () => {
    monta(["VIP"]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "vip{Enter}");
    expect(mutate).not.toHaveBeenCalled();
    // E a variante também não é oferecida como "nova": ela já existe (marcada).
    expect(screen.queryByRole("button", { name: /Criar etiqueta/ })).toBeNull();
  });

  it("digitar a etiqueta do vocabulário em outra caixa ou sem acento não a oferece como nova; Enter marca a existente", async () => {
    monta([]);
    await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "indicacao");
    expect(screen.queryByRole("button", { name: /Criar etiqueta/ })).toBeNull();
    await userEvent.keyboard("{Enter}");
    // Grava a chave da etiqueta CADASTRADA ("indicação"), não a digitada.
    expect(mutate).toHaveBeenCalledWith({ tags: ["indicação"] });
  });
});

describe("ContactTagsEditor — limite e estados", () => {
  it("no limite de 20, as não marcadas e o criar ficam travados; as marcadas ainda saem", async () => {
    const vinte = Array.from({ length: 20 }, (_, i) => `t${i}`);
    monta(["google ads", ...vinte.slice(1)]);
    const google = await screen.findByRole("checkbox", { name: "Google Ads" }, espera);
    expect((google as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Indicação" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Limite de 20 tags/)).toBeTruthy();

    await userEvent.click(google);
    expect(mutate).toHaveBeenCalledWith({ tags: vinte.slice(1) });

    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "outra");
    expect((screen.getByRole("button", { name: /Criar etiqueta/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("empresa sem vocabulário: avisa e deixa criar digitando", async () => {
    monta([], []);
    expect(await screen.findByText(/ainda não tem etiquetas/, {}, espera)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "primeira{Enter}");
    expect(mutate).toHaveBeenCalledWith({ tags: ["primeira"] });
  });

  it("a falha da leitura é dita, e as tags do contato continuam editáveis", async () => {
    get.mockRejectedValue(new Error("500"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["vip"]} />
      </QueryClientProvider>,
    );
    const alerta = await screen.findByRole("alert", {}, espera);
    expect(within(alerta).getByText(/Não foi possível carregar as etiquetas/)).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "vip" }));
    expect(mutate).toHaveBeenCalledWith({ tags: [] });
  });
});
