/**
 * ONDA 3 DO REDESIGN — Contatos (lista e ficha) no v49.
 *
 * Desligada: o HTML é o de sempre, provado pelo retrato inteiro (a onda 3
 * acrescenta e reagrupa ELEMENTOS, então a ausência de atributo não basta).
 *
 * Ligada:
 * - lista: as ações raras (Personalizar colunas, Duplicados, Sincronizar
 *   agenda) vão para o menu "Mais ações"; Importar, Exportar e Novo contato
 *   ficam à vista; cada linha ganha o avatar com as iniciais.
 * - ficha: volta para Contatos, avatar, "Abrir conversa" no cabeçalho e as
 *   ações raras num "Mais ações" que só esconde (os diálogos continuam
 *   montados).
 * - O CONJUNTO de ações alcançáveis é o mesmo com a chave ligada e desligada,
 *   por papel. Só muda onde elas ficam.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";
import { ContactsListClient } from "@/app/app/contacts/_client";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Contact } from "@/lib/types/contacts";

const h = vi.hoisted(() => ({ role: "admin" as string }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Loja", role: h.role, cliente_pela_agenda: false }),
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", name: "Loja", role: h.role, cliente_pela_agenda: false },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/contacts/useContactCount", () => ({ useContactCount: () => ({ data: 2 }) }));
vi.mock("@/hooks/contacts/useContactFilterOptions", () => ({
  useContactFilterOptions: () => ({ data: undefined }),
}));
vi.mock("@/hooks/contacts/useColunasDeContatos", async () => {
  const { COLUNAS_PADRAO } = await import("@/lib/contacts/colunas-da-lista");
  return { useColunasDeContatos: () => ({ colunas: [...COLUNAS_PADRAO] }) };
});
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/components/contacts/SyncPhoneContactsDialog", () => ({ SyncPhoneContactsDialog: () => null }));
vi.mock("@/components/channels/SeletorDeCanalParaConversa", () => ({
  useConversaNovaComEscolhaDeCanal: () => ({ iniciarConversa: vi.fn(), abrindo: false, seletor: null }),
}));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("@/components/contacts/ImportContactsDialog", () => ({ ImportContactsDialog: () => null }));
vi.mock("@/components/contacts/MergeDialog", () => ({ MergeDialog: () => null }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({
  ConversaNoDossie: () => <a href="/app/inbox?id=x" data-stub="conversa">Abrir conversa no Chat do CRM</a>,
}));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

const CONTATO = {
  id: "c-1",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: "joana@exemplo.test",
  email_normalized: null,
  phone_number: "+5511999998888",
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: ["VIP"],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({
    isLoading: false,
    isError: false,
    data: { pages: [{ data: [CONTATO, { ...CONTATO, id: "c-2", name: "Rui Lima", tags: [] }] }] },
    hasNextPage: false,
  }),
}));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ isLoading: false, isError: false, data: { data: CONTATO }, refetch: vi.fn() }),
}));

function montar(ui: ReactNode, ligado: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDoRedesign ligado={ligado}>{ui}</ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

/** Rótulos de todo botão e link da região, sem contar o próprio "Mais ações". */
function rotulos(regiao: HTMLElement): string[] {
  return [...regiao.querySelectorAll("button, a, summary")]
    .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim())
    .filter((r) => r && r !== "Mais ações");
}

beforeEach(() => {
  h.role = "admin";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("onda 3 — Contatos, chave DESLIGADA", () => {
  it("lista: HTML idêntico ao de sempre", () => {
    const { container } = montar(<ContactsListClient />, false);
    expect(screen.getByText("Joana Prado")).toBeInTheDocument();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it.each(["admin", "agent"])("ficha (%s): HTML idêntico ao de sempre", (role) => {
    h.role = role;
    const { container } = montar(<ContactDetailClient contactId="c-1" />, false);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana Prado");
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe.skip("onda 3 — Contatos, chave LIGADA", () => {
  it("lista: ações raras no 'Mais ações', as do dia a dia à vista, e o mesmo conjunto de ações", async () => {
    const user = userEvent.setup();
    const desligada = montar(<ContactsListClient />, false);
    const cabecalhoDesligado = desligada.container.querySelector("header") as HTMLElement;
    const antes = rotulos(cabecalhoDesligado).sort();
    cleanup();

    montar(<ContactsListClient />, true);
    const cabecalho = document.querySelector('[data-rd-contatos="cabecalho"]') as HTMLElement;
    const visiveis = rotulos(cabecalho);
    expect(visiveis).toEqual(expect.arrayContaining(["Importar CSV", "Exportar", "Novo contato"]));
    expect(visiveis).not.toContain("Duplicados");

    await user.click(within(cabecalho).getByRole("button", { name: "Mais ações" }));
    const itens = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim() ?? "");
    expect(itens).toEqual(["Personalizar colunas", "Duplicados", "Sincronizar agenda"]);
    expect([...visiveis, ...itens].sort()).toEqual(antes);
  });

  it("lista: cada linha tem o avatar com as iniciais", () => {
    montar(<ContactsListClient />, true);
    const avatares = [...document.querySelectorAll('[data-rd-contatos="avatar"]')].map((a) => a.textContent);
    expect(avatares).toEqual(["JP", "RL"]);
  });

  it("ficha: volta para Contatos, avatar e 'Abrir conversa' no cabeçalho", () => {
    montar(<ContactDetailClient contactId="c-1" />, true);
    const cabecalho = document.querySelector('[data-rd-contatos="ficha-cabecalho"]') as HTMLElement;
    expect(screen.getByRole("link", { name: /Contatos/ })).toHaveAttribute("href", "/app/contacts");
    expect(cabecalho.querySelector('[data-rd-contatos="avatar"]')?.textContent).toBe("JP");
    expect(within(cabecalho).getByText("Abrir conversa no Chat do CRM")).toBeInTheDocument();
    // Uma conversa só na tela: a faixa larga de baixo sai quando ela sobe.
    expect(document.querySelectorAll('[data-stub="conversa"]')).toHaveLength(1);
  });

  it.each(["admin", "manager", "agent"])(
    "ficha (%s): o mesmo conjunto de ações, com as raras escondidas no 'Mais ações'",
    (role) => {
      h.role = role;
      const desligada = montar(<ContactDetailClient contactId="c-1" />, false);
      const antes = rotulos(desligada.container.querySelector("header") as HTMLElement).sort();
      cleanup();

      montar(<ContactDetailClient contactId="c-1" />, true);
      const cabecalho = document.querySelector('[data-rd-contatos="ficha-cabecalho"]') as HTMLElement;
      const depois = rotulos(cabecalho).filter((r) => r !== "Contatos" && r !== "Abrir conversa no Chat do CRM").sort();
      expect(depois).toEqual(antes);

      const mais = cabecalho.querySelector('[data-rd-contatos="mais-acoes"]');
      const raras = ["Marcar como pessoal", "Marcar como sempre humano", "Juntar com outra ficha"];
      const temRaras = antes.some((r) => raras.includes(r));
      // Sem ação rara para o papel, nada de gatilho vazio.
      expect(Boolean(mais)).toBe(temRaras);
      if (mais) {
        for (const r of raras.filter((x) => antes.includes(x))) {
          expect(within(mais as HTMLElement).getByText(r)).toBeInTheDocument();
        }
        expect(within(mais as HTMLElement).queryByText("Editar")).toBeNull();
      }
    },
  );
});
