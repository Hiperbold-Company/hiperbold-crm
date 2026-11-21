/**
 * OS DIÁLOGOS DE CONEXÃO NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * Os componentes de `components/connections` ganham `data-rd-dialogos="<peça>"` SÓ com a chave
 * ligada (`useMarcaDosDialogos`), e o bloco "redesign: dialogos" de `app/globals.css` os desenha.
 * O Gerenciar troca de contêiner: desligado é o Dialog de sempre; ligado, a gaveta lateral (Sheet,
 * lado direito) com o mesmo corpo. Provado aqui:
 *
 *   1. DOM desligado — nenhum `data-rd-dialogos`, e o Gerenciar é o Dialog (`max-w-3xl`, sem lado).
 *   2. DOM ligado — as peças principais aparecem; o Gerenciar é a gaveta à direita, com OS MESMOS
 *      botões que o Dialog mostra.
 *   3. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]` (com controle negativo).
 *
 * Os diálogos são portal no `body`: toda consulta é em `document.body`, nunca no `container`
 * (que daria zero até com a chave ligada).
 *
 * NÃO prova a aparência: jsdom não pinta; a semelhança com o protótipo v49 só se confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CartaoDaConexao } from "@/lib/channels/conexoes-em-cartoes";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(async (rota: string) => (rota.includes("pairing-code") ? { data: { code: "ABCD-1234" } } : { data: {} })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/app/connections",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  // Administrador da plataforma: o Criar mostra também o avançado (credenciais à mão).
  useAuth: () => ({ user: { is_platform_admin: true, support: null } }),
  usePermission: () => true,
  usePaisDaOrgAtiva: () => "BR",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api/client", async (original) => ({
  ...((await original()) as object),
  apiClient: { get: h.get, post: h.post, delete: vi.fn(async () => ({})) },
}));
// Fala com outra rota e não é peça deste item.
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));

import { CriarConexao, type TipoDoCriar } from "@/components/connections/CriarConexao";
import { EscolherContasDaMeta } from "@/components/connections/EscolherContasDaMeta";
import { GerenciarConexao } from "@/components/connections/GerenciarConexao";
import { PairingOptions } from "@/components/connections/PairingOptions";
import { QrDialog } from "@/components/connections/PareamentoPorSessao";
import { marcaDosDialogos } from "@/lib/redesign/dialogos";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

h.get.mockImplementation(async (rota: string) => {
  if (rota.includes("plataforma=")) {
    return {
      data: {
        plataforma: "instagram",
        expira_em: "2026-11-21T00:10:00Z",
        contas: [{ id: "p1", nome: "Loja", usuario: "loja", ja_conectada_aqui: false, em_outra_empresa: false }],
      },
    };
  }
  // O QrDialog pergunta o status da sessão: em SCAN_QR_CODE mostra o QR e a escolha QR / código.
  if (rota === "/api/v1/channel-sessions/s1") return { data: { status: "SCAN_QR_CODE" } };
  // O QR novo retoma um pareamento pendente: a tela abre direto nos passos numerados.
  if (rota === "/api/v1/channels/pareamento-qr") {
    return { data: { disponivel: true, pendente: { id: "p1", expira_em: "2099-01-01T00:00:00Z" } } };
  }
  return { data: {} };
});

/** Conexão por QR em sessão, caída: o ramo que mostra TODAS as ações sem esperar consulta. */
const SESSAO: CartaoDaConexao = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "waha",
  tipo: "whatsapp_qr",
  via: null,
  nome: "Suporte",
  numero_ou_handle: "+55 11 90000-0003",
  status: "desconectado",
  status_bruto: "SCAN_QR_CODE",
  pareamento: "sessao",
  created_at: "2026-11-17T00:00:00Z",
  oficial: null,
};

function montar(no: ReactNode, ligado: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = <QueryClientProvider client={qc}>{no}</QueryClientProvider>;
  return render(ligado ? <ProvedorDoRedesign ligado>{arvore}</ProvedorDoRedesign> : arvore);
}

const gerenciar = (ligado: boolean) =>
  montar(<GerenciarConexao conexao={SESSAO} aoFechar={() => {}} aoMudar={() => {}} podeEditarProtecao />, ligado);

const criar = (tipo: TipoDoCriar, ligado: boolean) =>
  montar(
    <CriarConexao
      aberto
      aoFechar={() => {}}
      tipoInicial={tipo}
      mostrar={{ parceiro: false, telefonia: false, sociais: true, voz: false, qrPorSessao: true }}
      wacallsConfigured={false}
      pareamentoQr
      aoMudar={() => {}}
    />,
    ligado,
  );

/** O que cada caminho mostra, montado um por vez (os diálogos não se sobrepõem). */
async function percorrerTudo(ligado: boolean): Promise<string[]> {
  const pecas: string[] = [];
  const colher = () =>
    pecas.push(
      ...Array.from(document.body.querySelectorAll("[data-rd-dialogos]")).map((e) => e.getAttribute("data-rd-dialogos") ?? ""),
    );

  gerenciar(ligado);
  await screen.findByTestId("gerenciar-bloco-comum");
  colher();
  cleanup();

  for (const tipo of ["whatsapp_oficial", "whatsapp_qr", "whatsapp_qr_sessao"] as const) {
    criar(tipo, ligado);
    await screen.findByTestId(`criar-conteudo-${tipo}`);
    if (tipo === "whatsapp_qr") await screen.findByText("Abra o WhatsApp no celular.");
    colher();
    cleanup();
  }

  montar(
    <QrDialog sessionId="s1" title="Conectar" ativo onClose={() => {}} onConnected={() => {}} onForcePair={async () => {}} />,
    ligado,
  );
  await screen.findByAltText("QR Code para conectar WhatsApp");
  colher();
  cleanup();

  montar(<PairingOptions sessionId="s1" qr={<div>qr</div>} />, ligado);
  fireEvent.click(screen.getByRole("button", { name: "Conectar por código" }));
  fireEvent.change(screen.getByLabelText("Telefone com código do país e DDD"), { target: { value: "+55 11 99999-1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Gerar código" }));
  await screen.findByText("ABCD-1234");
  colher();
  cleanup();

  montar(<EscolherContasDaMeta plataforma="instagram" aoFechar={() => {}} aoConcluir={() => {}} />, ligado);
  await screen.findByTestId("confirmar-contas-meta");
  colher();
  cleanup();

  return pecas;
}

/**
 * Os nomes dos botões dentro do Gerenciar, em ordem alfabética: o "Fechar" da gaveta vem antes do
 * conteúdo no DOM e o do Dialog, depois — a posição muda, o conjunto de ações não.
 */
function botoesDoGerenciar(): string[] {
  const raiz = screen.getByTestId("gerenciar-conexao");
  return Array.from(raiz.querySelectorAll("button"))
    .map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
    .sort();
}

afterEach(() => cleanup());

describe("redesign: diálogos de conexão, DOM", () => {
  it("desligado, nenhum caminho escreve data-rd-dialogos", async () => {
    expect(await percorrerTudo(false)).toEqual([]);
  });

  it("desligado, o Gerenciar é o Dialog de sempre (não a gaveta)", async () => {
    gerenciar(false);
    await screen.findByTestId("gerenciar-bloco-comum");
    const raiz = screen.getByTestId("gerenciar-conexao");
    expect(raiz.getAttribute("data-slot")).toBe("dialog-content");
    expect(raiz.className).toContain("max-w-3xl");
    expect(raiz.hasAttribute("data-lado")).toBe(false);
    expect(document.body.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it("ligado, as peças principais aparecem", async () => {
    const pecas = await percorrerTudo(true);
    for (const p of [
      "gaveta",
      "cabecalho",
      "titulo",
      "descricao",
      "corpo",
      "tipos",
      "tipo",
      "secao",
      "secao-titulo",
      "secao-texto",
      "campo",
      "modos",
      "modo",
      "acoes",
      "aviso",
      "nota",
      "avancado",
      "forma",
      "passos",
      "qr",
      "codigo",
      "lista",
      "item",
      "rodape",
    ]) {
      expect(pecas, `peça ${p}`).toContain(p);
    }
  });

  it("ligado, o Gerenciar é a gaveta à direita, com os mesmos botões de ação do Dialog", async () => {
    gerenciar(false);
    await screen.findByTestId("gerenciar-bloco-comum");
    const noDialog = botoesDoGerenciar();
    cleanup();

    gerenciar(true);
    await screen.findByTestId("gerenciar-bloco-comum");
    const raiz = screen.getByTestId("gerenciar-conexao");
    expect(raiz.getAttribute("data-slot")).toBe("sheet-content");
    expect(raiz.getAttribute("data-lado")).toBe("right");
    expect(raiz.getAttribute("data-rd-dialogos")).toBe("gaveta");
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    // Continua sendo um diálogo nomeado pelo título da conexão.
    expect(screen.getByRole("dialog", { name: "Suporte" })).toBe(raiz);

    const naGaveta = botoesDoGerenciar();
    expect(naGaveta).toEqual(noDialog);
    for (const acao of ["Proteção de envio", "Fechar"]) expect(naGaveta).toContain(acao);
    expect(naGaveta.length).toBeGreaterThan(3);
  });

  it("ligado, a ação da gaveta funciona como no Dialog (abre a Proteção de envio)", async () => {
    gerenciar(true);
    await screen.findByTestId("gerenciar-bloco-comum");
    expect(screen.queryByTestId("anti-ban-indisponivel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Proteção de envio" }));
    // A ficha da proteção (sem item de pacing aqui: o estado "indisponível") abre por cima.
    expect(await screen.findByTestId("anti-ban-indisponivel")).toBeTruthy();
  });

  it("marcaDosDialogos (página de servidor): ligada devolve a peça, desligada undefined", () => {
    expect(marcaDosDialogos(true)("gaveta")).toBe("gaveta");
    expect(marcaDosDialogos(false)("gaveta")).toBeUndefined();
  });
});

describe("redesign: diálogos de conexão, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: dialogos ";
  const FIM = "/* redesign: dialogos — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    // O marcador de fim também começa por INICIO: repetido é outro início ANTES do fim.
    const outro = css.indexOf(INICIO, i + 1);
    if (outro >= 0 && outro < f) throw new Error("marcador de início repetido");
    return css.slice(i, f);
  }

  function erros(css: string): { regras: number; erros: string[] } {
    const out: string[] = [];
    let regras = 0;
    const raiz = postcss.parse(css);
    raiz.walkAtRules((at) => {
      if (at.name !== "media") out.push(`@${at.name} não é permitido`);
    });
    raiz.walkRules((r) => {
      regras++;
      for (const p of r.selectors) if (!p.trim().startsWith(ESCOPO)) out.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) out.push(`!important em ${d.prop}`);
    });
    return { regras, erros: out };
  }

  it('o bloco existe e todo seletor começa por [data-redesign="ligado"]', () => {
    const r = erros(bloco(CSS));
    expect(r.regras).toBeGreaterThan(30);
    expect(r.erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo, lista mista, @keyframes e !important", () => {
    const r = erros(
      `.x { color: red; } ${ESCOPO} .a, .b { color: red; } @keyframes k { to { opacity: 1; } } ${ESCOPO} .c { color: red !important; }`,
    );
    expect(r.erros).toContain("seletor sem escopo: .x");
    expect(r.erros).toContain("seletor sem escopo: .b");
    expect(r.erros).toContain("@keyframes não é permitido");
    expect(r.erros).toContain("!important em color");
  });
});
