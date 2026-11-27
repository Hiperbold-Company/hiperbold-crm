/**
 * A caixa do editor de fluxos tem de medir o MESMO com a chave do redesign
 * ligada e desligada.
 *
 * Por quê: o "Organizar" (FlowCanvas) usa a altura medida de cada caixa
 * (`n.measured.height`) e grava as posições no grafo. Se o visual novo somar
 * altura, a mesma automação organizada com a chave ligada grava posições
 * diferentes, e um grafo organizado com o visual de sempre fica com caixas
 * encostadas ou sobrepostas quando a empresa liga o visual novo.
 *
 * O jsdom não mede layout; a prova de medida é no navegador
 * (getBoundingClientRect). Aqui se vigia o CSS que muda a caixa: nenhuma regra
 * do bloco do editor pode mexer em altura, espaço vertical, borda de cima/baixo
 * ou entrelinha das peças da caixa, e o rótulo do papel fica fora do fluxo.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function blocoDoEditor(fonte: string): string {
  const ini = fonte.indexOf("/* redesign: editor");
  const fim = fonte.indexOf("/* redesign: editor — fim");
  expect(ini).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(ini);
  return fonte.slice(ini, fim);
}

function regras(bloco: string): { seletor: string; corpo: string }[] {
  const semComentario = bloco.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...semComentario.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    seletor: m[1]!.trim(),
    corpo: m[2]!,
  }));
}

/** Peças que ficam DENTRO da caixa e decidem a altura dela. */
const PECA_DA_CAIXA = /\[data-rd-editor(\^)?="(no-|titulo|resumo|icone|ramos|erro)/;
const MEXE_NA_ALTURA =
  /(?:^|;|\s)(height|min-height|max-height|padding|padding-top|padding-bottom|margin|margin-top|margin-bottom|line-height|border-width|border-top-width|border-bottom-width|border-top|border-bottom|border)\s*:\s*([^;]+)/g;

function violacoes(bloco: string): string[] {
  const achados: string[] = [];
  for (const { seletor, corpo } of regras(bloco)) {
    if (!PECA_DA_CAIXA.test(seletor) || seletor.includes(".react-flow__handle")) continue;
    for (const m of corpo.matchAll(MEXE_NA_ALTURA)) {
      const prop = m[1]!;
      const valor = m[2]!.trim();
      // Permitidos: a borda fina de sempre (1px) e o ícone com a altura do h-6 (24px).
      if (/^border(-top|-bottom)?-width$/.test(prop) && valor === "1px") continue;
      if (prop === "height" && valor === "24px" && seletor.includes('"icone"')) continue;
      achados.push(`${seletor} → ${prop}: ${valor}`);
    }
  }
  return achados;
}

describe("editor: a caixa mede o mesmo com a chave ligada e desligada", () => {
  const bloco = blocoDoEditor(css);

  it("nenhuma regra do redesign muda altura, espaço vertical, borda de cima/baixo ou entrelinha da caixa", () => {
    expect(violacoes(bloco)).toEqual([]);
  });

  it("o rótulo do papel (QUANDO/SE/ENTÃO) fica fora do fluxo, acima da caixa", () => {
    const papel = regras(bloco).find((r) => r.seletor === '[data-redesign="ligado"] [data-rd-editor="papel"]');
    expect(papel).toBeDefined();
    expect(papel!.corpo).toMatch(/position:\s*absolute/);
    expect(papel!.corpo).toMatch(/bottom:\s*calc\(100% \+ \d+px\)/);
    const caixa = regras(bloco).find((r) => r.seletor === '[data-redesign="ligado"] [data-rd-editor^="no-"]');
    expect(caixa!.corpo).toMatch(/position:\s*relative/);
  });

  it("controle: a régua acusa uma borda de cima grossa e uma entrelinha nova", () => {
    const sabotado =
      '/* redesign: editor */ [data-redesign="ligado"] [data-rd-editor^="no-"] { border-top-width: 3px; }' +
      ' [data-redesign="ligado"] [data-rd-editor="resumo"] { line-height: 1.45; } /* redesign: editor — fim */';
    expect(violacoes(blocoDoEditor(sabotado))).toEqual([
      '[data-redesign="ligado"] [data-rd-editor^="no-"] → border-top-width: 3px',
      '[data-redesign="ligado"] [data-rd-editor="resumo"] → line-height: 1.45',
    ]);
  });
});
