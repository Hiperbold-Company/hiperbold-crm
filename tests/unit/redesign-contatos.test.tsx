/**
 * Redesign da área Contatos (lista, ficha, exclusão, Campanhas e Importações).
 *
 * Três garantias:
 * 1. Chave DESLIGADA: nenhuma tela escreve `data-rd-contatos` — o DOM é o de
 *    sempre, e nenhuma regra do bloco tem onde casar.
 * 2. Chave LIGADA: as peças que o CSS desenha estão marcadas.
 * 3. O bloco `redesign: contatos` de `app/globals.css` só tem seletor escopado
 *    por `[data-redesign="ligado"]` (mesma régua dos componentes base, com
 *    controle negativo), e cada peça que ele desenha existe numa tela — e
 *    vice-versa.
 *
 * As telas rodam de verdade; só os dados (rede, sessão, idioma) são fixos.
 */
import fs from "node:fs";
import path from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import postcss, { type Root } from "postcss";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ListaDeCampanhas } from "@/app/app/campaigns/_client";
import { ContactsListClient } from "@/app/app/contacts/_client";
import { ImportsListClient } from "@/app/app/imports/_client";
import { BarraDeContatosEmLote } from "@/components/contacts/BarraDeContatosEmLote";
import { ExcluirContatosEmLoteDialog } from "@/components/contacts/ExcluirContatosEmLoteDialog";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", role: "admin", cliente_pela_agenda: false }),
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
vi.mock("@/components/contacts/SyncPhoneContactsDialog", () => ({
  SyncPhoneContactsDialog: () => null,
}));
vi.mock("@/components/channels/SeletorDeCanalParaConversa", () => ({
  useConversaNovaComEscolhaDeCanal: () => ({
    iniciarConversa: vi.fn(),
    abrindo: false,
    seletor: null,
  }),
}));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("@/components/contacts/ImportContactsDialog", () => ({ ImportContactsDialog: () => null }));
vi.mock("@/components/contacts/MergeDialog", () => ({ MergeDialog: () => null }));

const CONTATO = {
  id: "c-1",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
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
  tags: [],
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
    data: { pages: [{ data: [CONTATO, { ...CONTATO, id: "c-2", name: "Rui Lima" }] }] },
    hasNextPage: false,
  }),
}));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCampanhas: () => ({
    isLoading: false,
    isError: false,
    hasNextPage: false,
    data: {
      pages: [
        {
          data: [
            {
              id: "cp-1",
              name: "Black Friday",
              status: "draft",
              snapshot_eligible: 0,
              snapshot_excluded: 0,
              scheduled_at: null,
              started_at: null,
              completed_at: null,
              created_at: "2026-11-01T10:00:00.000Z",
            },
          ],
        },
      ],
    },
  }),
}));

function montar(ui: ReactNode, ligado: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDoRedesign ligado={ligado}>{ui}</ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

/** As peças marcadas no documento inteiro (diálogo vai em portal no body). */
const pecas = () =>
  [...document.querySelectorAll("[data-rd-contatos]")].map((el) =>
    el.getAttribute("data-rd-contatos"),
  );

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redesign de Contatos: chave desligada não marca nada", () => {
  it("lista de contatos, com seleção e lote, fica sem data-rd-*", async () => {
    const user = userEvent.setup();
    montar(<ContactsListClient />, false);
    // Controle positivo: a tela renderizou, e a seleção abriu as barras.
    expect(screen.getByText("Joana Prado")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Selecionar todos os contatos visíveis" }));
    expect(screen.getByTestId("barra-de-contatos-em-lote")).toBeInTheDocument();
    expect(pecas()).toEqual([]);
  });

  it("diálogo de exclusão, Campanhas e Importações ficam sem data-rd-*", async () => {
    montar(
      <>
        <ExcluirContatosEmLoteDialog
          open
          quantidade={3}
          pendente={false}
          onConfirm={vi.fn()}
          onOpenChange={vi.fn()}
        />
        <ListaDeCampanhas />
        <ImportsListClient />
      </>,
      false,
    );
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Black Friday")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Nenhuma importação ainda.")).toBeInTheDocument());
    expect(pecas()).toEqual([]);
  });
});

describe("redesign de Contatos: chave ligada marca as peças", () => {
  it("lista: cabeçalho, filtros, busca, tabela, rodapé, seleção e lote", async () => {
    const user = userEvent.setup();
    montar(<ContactsListClient />, true);
    await user.click(screen.getByRole("button", { name: "Selecionar todos os contatos visíveis" }));
    expect(pecas()).toEqual(
      expect.arrayContaining([
        "lista",
        "cabecalho",
        "titulo",
        "subtitulo",
        "filtros",
        "busca",
        "selecao",
        "lote",
        "tabela",
        "tabela-contatos",
        "rodape",
      ]),
    );
    // O atributo é inerte: a função segue a mesma (testid e papel intactos).
    expect(screen.getByTestId("barra-de-contatos-em-lote")).toHaveAttribute(
      "data-rd-contatos",
      "lote",
    );
  });

  it("diálogo de exclusão, Campanhas e Importações", async () => {
    montar(
      <>
        <ExcluirContatosEmLoteDialog
          open
          quantidade={3}
          pendente={false}
          onConfirm={vi.fn()}
          onOpenChange={vi.fn()}
        />
        <ListaDeCampanhas />
        <ImportsListClient />
      </>,
      true,
    );
    expect(await screen.findByRole("alertdialog")).toHaveAttribute(
      "data-rd-contatos",
      "dialogo-excluir",
    );
    expect(pecas()).toEqual(
      expect.arrayContaining([
        "campanhas",
        "titulo-area",
        "subtitulo-area",
        "filtros",
        "campo",
        "lista-de-cartoes",
        "item",
        "item-nome",
        "importacoes",
        "envio",
        "tabela",
      ]),
    );
  });

  it("a barra de lote sozinha também se marca", () => {
    montar(
      <BarraDeContatosEmLote
        quantidade={2}
        pendente={false}
        onAdicionarEtiqueta={vi.fn()}
        onRemoverEtiqueta={vi.fn()}
        onPreencherCampo={vi.fn()}
        onLimpar={vi.fn()}
      />,
      true,
    );
    expect(screen.getByRole("toolbar")).toHaveAttribute("data-rd-contatos", "lote");
  });
});

// ---- o CSS -----------------------------------------------------------------

const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const INICIO = "/* redesign: contatos */";
const FIM = "/* redesign: contatos — fim */";
const ESCOPO = '[data-redesign="ligado"]';

function extrairBloco(css: string): string {
  const i = css.indexOf(INICIO);
  const f = css.indexOf(FIM);
  if (i < 0 || f < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
  if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
  return css.slice(i + INICIO.length, f);
}

function partes(seletor: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let atual = "";
  for (const ch of seletor) {
    if (ch === "(" || ch === "[") nivel++;
    if (ch === ")" || ch === "]") nivel--;
    if (ch === "," && nivel === 0) {
      out.push(atual);
      atual = "";
    } else atual += ch;
  }
  out.push(atual);
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

function violacoes(bloco: string): { regras: number; erros: string[] } {
  const raiz: Root = postcss.parse(bloco);
  const erros: string[] = [];
  let regras = 0;
  raiz.walkAtRules((at) => {
    if (at.name !== "media") erros.push(`@${at.name} ${at.params} não é permitido no bloco`);
  });
  raiz.walkRules((regra) => {
    regras++;
    for (const p of partes(regra.selector)) {
      if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
    }
  });
  raiz.walkDecls((d) => {
    if (d.important) erros.push(`!important em ${d.prop}`);
  });
  return { regras, erros };
}

/** Os arquivos que escrevem as marcas (`rd("peça")`). */
const TELAS = [
  "app/app/contacts/_client.tsx",
  "app/app/contacts/[id]/_client.tsx",
  "app/app/campaigns/_client.tsx",
  "app/app/imports/_client.tsx",
  "components/contacts/ContactsTable.tsx",
  "components/contacts/BarraDeSelecaoDeContatos.tsx",
  "components/contacts/BarraDeContatosEmLote.tsx",
  "components/contacts/ExcluirContatosEmLoteDialog.tsx",
];

describe("redesign de Contatos: o bloco de CSS", () => {
  it('existe, tem regras e todo seletor começa por [data-redesign="ligado"]', () => {
    const { regras, erros } = violacoes(extrairBloco(CSS));
    expect(regras).toBeGreaterThan(20);
    expect(erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo, lista mista, @keyframes e !important", () => {
    const ruim = `
      [data-rd-contatos="lista"] { color: red; }
      ${ESCOPO} .a, .b { color: red; }
      @keyframes pulo { from { opacity: 0; } to { opacity: 1; } }
      ${ESCOPO} .c { color: blue !important; }
    `;
    const { erros } = violacoes(ruim);
    expect(erros).toContain('seletor sem escopo: [data-rd-contatos="lista"]');
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros.some((e) => e.startsWith("@keyframes"))).toBe(true);
    expect(erros).toContain("!important em color");
  });

  it("toda peça desenhada no CSS é marcada por alguma tela, e toda marca tem desenho", () => {
    const noCss = new Set(
      [...extrairBloco(CSS).matchAll(/data-rd-contatos="([a-z-]+)"/g)].map((m) => m[1]),
    );
    const nasTelas = new Set(
      TELAS.flatMap((f) =>
        [
          ...fs.readFileSync(path.join(process.cwd(), f), "utf8").matchAll(/rd\("([a-z-]+)"\)/g),
        ].map((m) => m[1]),
      ),
    );
    expect(noCss.size).toBeGreaterThan(10);
    expect([...noCss].filter((p) => !nasTelas.has(p))).toEqual([]);
    expect([...nasTelas].filter((p) => !noCss.has(p))).toEqual([]);
  });
});
