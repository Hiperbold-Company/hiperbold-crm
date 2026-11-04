import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { apiClient } from "@/lib/api/client";
import type { OpcaoDeEtiqueta } from "@/lib/tags/etiquetas-para-escolher";

/**
 * Hiperbold: o editor de tags do contato é a LISTA de etiquetas da empresa
 * (`SeletorDeEtiquetas`, caixa de marcar por etiqueta), não o campo de texto
 * livre com chips "+ tag" do upstream. Este arquivo veio do upstream (#2718,
 * #3180) e foi reescrito para a nossa interface na junção de 04/11/2026
 * (decisão g8 #2 do merge): as intenções do #3180 continuam medidas — o filtro
 * pelo digitado, sem caixa e sem acento, casando no meio da palavra; a ordem da
 * fonte com o campo vazio; o Enter aplicando a existente; criar só o que não
 * existe e por último. A cor da etiqueta (#2718) não é escolhida neste editor:
 * mora em Configurações › Tags, e aqui só se mostra o ponto da cor cadastrada.
 */

let papel = "manager";
const mutateSpy = vi.fn();
/** O vocabulário que o hook devolve — a ORDEM dele é a da lista. */
const vocabularioRef: { current: OpcaoDeEtiqueta[] } = { current: [] };
const semGrupo = (...tags: string[]): OpcaoDeEtiqueta[] =>
  tags.map((tag) => ({ tag, cor: null, grupo: null }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: mutateSpy, isPending: false }),
}));
vi.mock("@/hooks/contacts/useEtiquetasParaEscolher", () => ({
  useEtiquetasParaEscolher: () => ({ data: vocabularioRef.current, isLoading: false, isError: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderEditor(tags: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContactTagsEditor entityId="k1" orgId="o1" tags={tags} />
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByLabelText("Adicionar tag ao contato");
const caixa = (tag: string) => screen.queryByRole("checkbox", { name: tag });
const opcaoDeCriar = () => screen.queryByRole("button", { name: /^Criar etiqueta/ });

describe("ContactTagsEditor — cor (Hiperbold: a cor vem do cadastro)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  it("marcar uma etiqueta só a anexa no contato; nada vai ao vocabulário", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("vip");
    renderEditor();
    await user.click(caixa("vip") as HTMLElement);
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("a etiqueta com cor mostra o ponto da cor cadastrada, sem gatilho de cor aqui", () => {
    vocabularioRef.current = [{ tag: "vip", cor: "#0091ff", grupo: null }];
    const { container } = renderEditor();
    const ponto = container.querySelector('[data-ponto-da-etiqueta="vip"]') as HTMLElement | null;
    expect(ponto).not.toBeNull();
    expect((ponto!.getAttribute("style") ?? "").replace(/\s/g, "")).toMatch(/rgb\(0,145,255\)|#0091ff/i);
    expect(screen.queryByRole("button", { name: /Cor da etiqueta/ })).toBeNull();
  });

  it("para papel agent o gatilho de cor não existe", () => {
    papel = "agent";
    vocabularioRef.current = semGrupo("vip");
    renderEditor();
    expect(screen.queryByRole("button", { name: /Cor da etiqueta/ })).not.toBeInTheDocument();
  });
});

/**
 * A LISTA FILTRA PELO QUE SE DIGITA (#3180): sem caixa, sem acento, casando no
 * MEIO da palavra. Com o campo vazio, a ordem é a da FONTE, não a do alfabeto.
 */
describe("ContactTagsEditor — a lista filtra pelo digitado (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  it("digitar “carteira” acha carteira-* com hífen e acento fora da conta", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-danilo", "carteira-joão", "origem-site");
    renderEditor();

    // Caixa alta de propósito: a chave é sem caixa, como a da busca.
    await user.type(campo(), "CARTEIRA");

    expect(caixa("carteira-andreia")).not.toBeNull();
    expect(caixa("carteira-danilo")).not.toBeNull();
    expect(caixa("carteira-joão")).not.toBeNull();
    expect(caixa("origem-site")).toBeNull();
  });

  it("digitado sem acento acha a etiqueta com acento", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-joão");
    renderEditor();

    await user.type(campo(), "joao");

    expect(caixa("carteira-joão")).not.toBeNull();
    expect(caixa("carteira-andreia")).toBeNull();
  });

  it("casa no MEIO da palavra (“teira” em “carteira”), não só no começo", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-danilo", "origem-site");
    renderEditor();

    await user.type(campo(), "teira");

    expect(caixa("carteira-andreia")).not.toBeNull();
    expect(caixa("carteira-danilo")).not.toBeNull();
    expect(caixa("origem-site")).toBeNull();
  });

  it("com o campo vazio a lista sai na ordem da fonte, não na do alfabeto", () => {
    vocabularioRef.current = semGrupo("zebra-frequente", "yy-usada", "aa-primeira-do-alfabeto");
    renderEditor();

    expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
      "zebra-frequente",
      "yy-usada",
      "aa-primeira-do-alfabeto",
    ]);
  });

  it("o filtro manda: acha o que casa mesmo depois da oitava posição", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo(
      ...Array.from({ length: 9 }, (_, i) => `tag-${String(i).padStart(2, "0")}`),
      "carteira-alvo",
    );
    renderEditor();

    await user.type(campo(), "alvo");

    expect(caixa("carteira-alvo")).not.toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("a etiqueta que o contato já tem, mesmo em outra caixa, aparece marcada e uma vez só", () => {
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-danilo");
    renderEditor(["Carteira-Andreia"]);

    expect((caixa("carteira-andreia") as HTMLInputElement).checked).toBe(true);
    expect((caixa("carteira-danilo") as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});

/**
 * CRIAR É A ÚLTIMA OPÇÃO, E SÓ QUANDO O TEXTO NÃO EXISTE AINDA (#3180): a
 * EXISTENTE vence quem digita a variante de memória.
 */
describe("ContactTagsEditor — criar só o que não existe (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  it("o Enter APLICA a etiqueta existente quando o texto casa por caixa e acento", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-danilo");
    renderEditor();

    await user.type(campo(), "CARTEIRA-ANDRÉIA{Enter}");

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["carteira-andreia"] });
  });

  it("com texto que não existe, as que casam continuam na lista e criar também é oferecido", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia", "carteira-danilo");
    renderEditor();

    await user.type(campo(), "carteira");

    expect(caixa("carteira-andreia")).not.toBeNull();
    expect(caixa("carteira-danilo")).not.toBeNull();
    expect(opcaoDeCriar()?.textContent).toContain("“carteira”");
  });

  it("com correspondência exata a opção de criar não aparece", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia");
    renderEditor();

    await user.type(campo(), "Carteira-Andreia");

    expect(caixa("carteira-andreia")).not.toBeNull();
    expect(opcaoDeCriar()).toBeNull();
  });

  it("clicar em Criar grava a etiqueta nova, pela régua do banco", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = semGrupo("carteira-andreia");
    renderEditor();

    await user.type(campo(), "Indicação de Parceiro");
    const criar = opcaoDeCriar();
    expect(criar).not.toBeNull();

    await user.click(criar as HTMLElement);

    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["indicação de parceiro"] });
  });

  it("não oferece criar uma etiqueta que o contato já tem", async () => {
    const user = userEvent.setup();
    renderEditor(["vip"]);

    await user.type(campo(), "VIP");

    expect(opcaoDeCriar()).toBeNull();
  });
});
