/**
 * ⌘K. Até aqui a barra "Buscar…" do topo era um `console.info` com o comentário
 * "UI not yet implemented" — a única saída de emergência para quem não achava
 * uma tela era uma promessa vazia.
 *
 * A busca de contatos e conversas tem o próprio arquivo:
 * tests/unit/command-palette-acha-dados.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CommandPalette } from "@/components/shell/CommandPalette";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const push = vi.fn();
const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

// Busca de dados (contatos/conversas) responde vazio: estes casos medem só a de telas.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  push.mockClear();
  comoPapel("admin");
});

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("CommandPalette", () => {
  it("acha uma tela que o sidebar não mostra", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    expect(screen.getByRole("option", { name: /Conhecimento/ })).toBeTruthy();
  });

  it("ignora acento, porque ninguém digita acento com pressa", async () => {
    const user = userEvent.setup();
    abrir();
    // Era "orcamento" → "Uso e orçamento", tela que saiu do catálogo em 25/11/2026.
    await user.type(screen.getByRole("combobox"), "execucoes");
    expect(screen.getByRole("option", { name: /Execuções/ })).toBeTruthy();
  });

  it("busca também na descrição, não só no rótulo", async () => {
    const user = userEvent.setup();
    abrir();
    // Ninguém procura "Radar" por esse nome; procura pelo problema que resolve.
    await user.type(screen.getByRole("combobox"), "esfriou");
    expect(screen.getByRole("option", { name: /Radar/ })).toBeTruthy();
  });

  it("busca também nos termos do destino, que não estão no rótulo nem na descrição", async () => {
    const user = userEvent.setup();
    abrir();
    // "gatilho" só está nos `termos` de Automações.
    await user.type(screen.getByRole("combobox"), "gatilho");
    expect(screen.getByRole("option", { name: /^Automações/ })).toBeTruthy();
  });

  it("Provedores (onde mora o Jev) está oculto nesta instalação e não aparece na busca", async () => {
    const user = userEvent.setup();
    abrir();
    // Oculto em 16/10/2026 (hiperbold/FUNCOES.md). A descrição que coloca o "Jev" no começo continua
    // no catálogo para o dia em que a função voltar.
    await user.type(screen.getByRole("combobox"), "jev");
    expect(screen.queryByRole("option", { name: /Provedores/ })).toBeNull();
  });

  it("o texto de apoio do item destacado usa a cor de frente do destaque, não o cinza", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhecimento");
    const destacada = screen.getByRole("option", { selected: true });
    // Cinza sobre o verde do destaque dava 1,2:1. Sem opacidade: o piso de
    // 4,5:1 de lib/branding/contraste.ts só vale para a cor de frente INTEIRA.
    for (const apoio of [
      destacada.querySelector("p")!,
      destacada.querySelector("span.uppercase")!,
    ]) {
      expect(apoio.classList).toContain("text-accent-foreground");
      expect(apoio.className).not.toMatch(/text-accent-foreground\//);
      expect(apoio.className).not.toContain("text-muted-foreground");
    }
  });

  it("respeita o papel", async () => {
    comoPapel("agent");
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "hist");
    expect(screen.queryByRole("option", { name: /Histórico de ações/ })).toBeNull();
  });

  it("Enter navega para o item destacado", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/app/ai/knowledge/sources");
  });

  it("seta para baixo move o destaque antes do Enter", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "a");
    await user.keyboard("{ArrowDown}{Enter}");
    const segundo = screen.getAllByRole("option")[1];
    expect(segundo).toBeDefined();
    expect(push).toHaveBeenCalledWith(segundo?.getAttribute("data-href"));
  });

  it("sem texto, oferece o trabalho do dia em vez de tela vazia", () => {
    abrir();
    expect(screen.getByRole("option", { name: /Chat/ })).toBeTruthy();
  });

  it("diz quando não achou, em vez de sumir sem explicação", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // Os grupos de dados carregam depois da digitação; o aviso vem quando todos voltam vazios.
    expect(await screen.findByText(/Nada encontrado/i)).toBeTruthy();
  });

  it("permite filtrar por categorias através dos botões", async () => {
    const user = userEvent.setup();
    abrir();
    const btnAtendimento = screen.getByRole("button", { name: /Atendimento/i });
    expect(btnAtendimento).toBeTruthy();
    await user.click(btnAtendimento);
    // Ao filtrar por Atendimento, itens de CRM ou Funcionários não devem aparecer
    expect(screen.getByRole("option", { name: /Chat/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Contatos/ })).toBeNull();
  });

  it("no catálogo, abre em Atendimento e a seta segue a ordem da tela", async () => {
    const user = userEvent.setup();
    abrir();
    // O catálogo começa por Prospecção (CRM): agrupar pela 1ª aparição punha
    // CRM no topo, e a seta andava pela lista plana, pulando de seção.
    // Desde 15/10/2026 Início (grupo Atendimento) é a primeira porta do menu.
    const opcoes = screen.getAllByRole("option");
    expect(opcoes[0]?.getAttribute("data-href")).toBe("/app/inicio");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledWith(opcoes[1]?.getAttribute("data-href"));
  });
});
