/**
 * ⌘K que acha dados: contatos e conversas pelas MESMAS rotas das listas
 * (`/api/v1/contacts?search=` e `/api/v1/conversations?search=`), com piso de
 * 2 caracteres, espera de digitação e erro que não derruba a busca de telas.
 * Negócios ficam de fora até existir rota de busca por texto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const CONTATO = { id: "c-1", name: "Maria Souza", display_name: null, phone_number: "5535999990000", email: null };
const CONVERSA = { id: "v-1", contacts: { name: "João Lima", display_name: null, phone_number: null }, channel_sessions: null };

let falhar = false;
const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  const u = String(url);
  if (falhar) return new Response(JSON.stringify({ error: { code: "forbidden", message: "x" } }), { status: 403, headers: { "content-type": "application/json" } });
  const corpo = u.includes("/api/v1/contacts") ? { data: [CONTATO] } : u.includes("/api/v1/conversations") ? { data: [CONVERSA] } : { data: [] };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  falhar = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

const chamadasDeBusca = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /\/api\/v1\/(contacts|conversations)\?/.test(u));

describe("⌘K acha contatos e conversas", () => {
  it("com 1 caractere não busca dado nenhum", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "m");
    await new Promise((r) => setTimeout(r, 400));
    expect(chamadasDeBusca()).toHaveLength(0);
  });

  it("com 2 ou mais busca uma vez por lista, depois da digitação, e mostra os grupos", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "mar");
    await screen.findByRole("option", { name: /Maria Souza/ });
    expect(screen.getByRole("option", { name: /João Lima/ })).toBeTruthy();
    const urls = chamadasDeBusca();
    expect(urls.filter((u) => u.includes("/contacts?"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/conversations?"))).toHaveLength(1);
    expect(urls.every((u) => u.includes("search=mar") && u.includes("limit=5"))).toBe(true);
  });

  it("Enter num contato abre a ficha dele", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "maria");
    await screen.findByRole("option", { name: /Maria Souza/ });
    // Desce até o contato (as telas, se houver, vêm antes).
    for (let i = 0; i < 30; i++) {
      const ativo = document.getElementById(
        screen.getByRole("combobox").getAttribute("aria-activedescendant") ?? "",
      );
      if (ativo?.textContent?.includes("Maria Souza")) break;
      await user.keyboard("{ArrowDown}");
    }
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/app/contacts/c-1");
  });

  it("durante a espera da digitação, item do termo anterior não conta para o teclado", async () => {
    const user = userEvent.setup();
    abrir();
    const caixa = screen.getByRole("combobox");
    // "zq" não casa tela nenhuma: o único item seria o contato do termo velho.
    await user.type(caixa, "zq");
    await screen.findByRole("option", { name: /Maria Souza/ });
    await user.type(caixa, "x");
    // Ainda dentro dos 250 ms: o grupo está em esqueleto.
    expect(screen.queryByRole("option", { name: /Maria Souza/ })).toBeNull();
    const ativo = caixa.getAttribute("aria-activedescendant");
    if (ativo) expect(document.getElementById(ativo)).not.toBeNull();
    await user.keyboard("{Enter}");
    expect(push).not.toHaveBeenCalledWith("/app/contacts/c-1");
  });

  it("erro na busca mostra a linha de erro e as telas continuam", async () => {
    falhar = true;
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    await waitFor(() => expect(screen.getAllByText("Não foi possível buscar agora.").length).toBeGreaterThan(0));
    expect(screen.getByRole("option", { name: /Conhecimento/ })).toBeTruthy();
  });
});
