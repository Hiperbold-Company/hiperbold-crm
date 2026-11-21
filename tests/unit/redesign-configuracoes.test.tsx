/**
 * CONFIGURAÇÕES NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * As telas não foram duplicadas: as peças compartilhadas ganham
 * `data-rd-configuracoes="<peça>"` SÓ com a chave ligada, e o bloco
 * "redesign: configuracoes" de `app/globals.css` as desenha. As duas metades
 * da garantia "desligado não muda nada":
 *
 *   1. DOM — chave desligada, nenhum atributo é escrito; ligada, as peças
 *      aparecem (índice, layout da área, formulário de perfil).
 *   2. CSS — toda regra do bloco começa por `[data-redesign="ligado"]`.
 *
 * Não prova a aparência: jsdom não pinta. A semelhança com o protótipo v49 só
 * se confere na tela.
 */
import fs from "node:fs";
import path from "node:path";

import { screen } from "@testing-library/react";
import postcss from "postcss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileForm } from "@/app/app/settings/profile/_form";
import { NavHub } from "@/components/shell/NavHub";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { marcaDasConfiguracoes } from "@/lib/redesign/configuracoes";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { render } from "@/tests/helpers/render-com-confirmacao";

const chave = vi.hoisted(() => ({ ligado: false }));

vi.mock("@/lib/redesign/chave", () => ({ redesignLigado: () => chave.ligado }));
vi.mock("@/app/actions/settings/updateProfile", () => ({
  updateProfile: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SettingsLayout from "@/app/app/settings/layout";

const ATRIBUTO = "[data-rd-configuracoes]";

function indice(redesign: boolean) {
  return render(
    <NavHub
      group="organizacao"
      isPlatformAdmin={false}
      role="admin"
      modulosLigados={[]}
      title="Configurações"
      subtitle="Sua conta"
      redesignConfiguracoes={redesign}
    />,
  );
}

function perfil(ligado: boolean) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <ProvedorDoRedesign ligado={ligado}>
        <ProfileForm
          email="dona@empresa.com"
          initialFullName="Dona"
          initialAvatarUrl={null}
          initialLocale="pt-BR"
          initialTimezone="America/Sao_Paulo"
        />
      </ProvedorDoRedesign>
    </IdiomaProvider>,
  );
}

function pecas(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(ATRIBUTO)).map(
    (el) => el.getAttribute("data-rd-configuracoes") ?? "",
  );
}

describe("marcaDasConfiguracoes (pura, vale no servidor)", () => {
  it("desligada devolve undefined; ligada devolve a própria peça", () => {
    expect(marcaDasConfiguracoes(false)("cabecalho")).toBeUndefined();
    expect(marcaDasConfiguracoes(true)("cabecalho")).toBe("cabecalho");
  });
});

describe("chave desligada: DOM idêntico ao de sempre", () => {
  beforeEach(() => {
    chave.ligado = false;
  });

  it("o índice não escreve atributo nenhum", () => {
    const { container } = indice(false);
    expect(screen.getByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    expect(container.querySelectorAll(ATRIBUTO)).toHaveLength(0);
  });

  it("o formulário de perfil não escreve atributo nenhum", () => {
    const { container } = perfil(false);
    expect(container.querySelectorAll(ATRIBUTO)).toHaveLength(0);
  });

  it("o layout da área devolve os filhos sem casca", () => {
    const { container } = render(
      <SettingsLayout>
        <p>filho</p>
      </SettingsLayout>,
    );
    expect(container.querySelectorAll(ATRIBUTO)).toHaveLength(0);
    expect(container.firstElementChild?.tagName).toBe("P");
  });
});

describe("chave ligada: as peças aparecem", () => {
  beforeEach(() => {
    chave.ligado = true;
  });

  it("o índice marca a página, o cabeçalho, as seções, a grade e os atalhos", () => {
    const { container } = indice(true);
    const lista = pecas(container);
    for (const p of ["indice", "cabecalho", "secao-do-indice", "grade-de-atalhos", "atalho"]) {
      expect(lista).toContain(p);
    }
  });

  it("o formulário de perfil marca o cartão e a barra de salvar", () => {
    const { container } = perfil(true);
    expect(pecas(container)).toEqual(expect.arrayContaining(["cartao", "barra-de-salvar"]));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
  });

  it("o layout da área embrulha os filhos na casca", () => {
    const { container } = render(
      <SettingsLayout>
        <p>filho</p>
      </SettingsLayout>,
    );
    const casca = container.querySelector('[data-rd-configuracoes="area"]');
    expect(casca).not.toBeNull();
    expect(casca?.textContent).toBe("filho");
  });
});

describe("CSS: o bloco redesign: configuracoes é todo escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: configuracoes";
  const FIM = "/* redesign: configuracoes — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) !== f) throw new Error("marcador de início repetido");
    return css.slice(i, f);
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

  function violacoes(css: string): { regras: number; erros: string[] } {
    const raiz = postcss.parse(css);
    const erros: string[] = [];
    let regras = 0;
    raiz.walkAtRules((at) => {
      if (at.name !== "media") erros.push(`@${at.name} ${at.params} não é permitido no bloco`);
    });
    raiz.walkRules((r) => {
      regras++;
      for (const p of partes(r.selector)) {
        if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
      }
    });
    raiz.walkDecls((d) => {
      if (d.important) erros.push(`!important em ${d.prop}`);
    });
    return { regras, erros };
  }

  it("o bloco existe e tem regras", () => {
    expect(violacoes(bloco(CSS)).regras).toBeGreaterThan(10);
  });

  it('todo seletor começa por [data-redesign="ligado"]', () => {
    expect(violacoes(bloco(CSS)).erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo e @keyframes", () => {
    const { erros } = violacoes(
      `.x { color: red; } ${ESCOPO} .a, .b { color: red; } @keyframes p { from { opacity: 0 } }`,
    );
    expect(erros).toContain("seletor sem escopo: .x");
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros.some((e) => e.startsWith("@keyframes"))).toBe(true);
  });
});
