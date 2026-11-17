/**
 * Faixa `sticky` com fundo translúcido deixa o conteúdo que rola aparecer por
 * trás dela. Os tons de estado (`bg-<estado>-bg`) são rgba de 12–18%, então
 * uma faixa fixa que usa um deles PRECISA de um fundo opaco junto
 * (`bg-surface`/`bg-bg`, com o tom por cima em gradiente) ou de um pai opaco.
 * Também não pode usar branco/preto fixo (`bg-white`, `bg-black`), que some
 * num dos temas — foi o botão dos avisos do topo no escuro.
 *
 * Achado do revisor e da auditoria de 17/11/2026 (ImpersonateBanner,
 * SuspendedBanner, LgpdRiskBanner e os três avisos de components/app).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");

function tsx(dir: string, saida: string[] = []): string[] {
  const abs = path.join(RAIZ, dir);
  if (!fs.existsSync(abs)) return saida;
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) {
      if (d.name === "node_modules" || d.name.startsWith(".")) continue;
      tsx(rel, saida);
    } else if (d.name.endsWith(".tsx") && !/\.test\.tsx$/.test(d.name)) {
      saida.push(rel);
    }
  }
  return saida;
}

/** Cada string de classe (entre aspas ou crases) que contém `sticky`. */
function classesSticky(fonte: string): string[] {
  const achadas: string[] = [];
  const re = /(["'`])((?:(?!\1)[^\n])*\bsticky\b(?:(?!\1)[^\n])*)\1/g;
  for (const m of fonte.matchAll(re)) if (m[2]) achadas.push(m[2]);
  return achadas;
}

const TOM_TRANSLUCIDO = /(?:^|\s)bg-(success|warning|error|info)-bg(?=\s|$)/;
const OPACO = /(?:^|\s)bg-(surface|bg|background|card|popover)(?=\s|$)/;

describe("faixas fixas (sticky) não deixam o conteúdo aparecer por trás", () => {
  const arquivos = [...tsx("app"), ...tsx("components")];

  it("o varredor acha as faixas que motivaram a regra", () => {
    const comSticky = arquivos.filter((f) =>
      classesSticky(fs.readFileSync(path.join(RAIZ, f), "utf8")).length > 0,
    );
    for (const f of [
      "components/app/ConexaoCaidaBanner.tsx",
      "components/app/ImpersonateBanner.tsx",
      "components/admin/lgpd/LgpdRiskBanner.tsx",
      "components/admin/tenants/SuspendedBanner.tsx",
    ]) {
      expect(comSticky, `${f} deveria ter sido varrido`).toContain(f);
    }
  });

  it("toda faixa sticky com tom de estado tem também fundo opaco", () => {
    const ruins: string[] = [];
    for (const f of arquivos) {
      for (const c of classesSticky(fs.readFileSync(path.join(RAIZ, f), "utf8"))) {
        if (TOM_TRANSLUCIDO.test(c) && !OPACO.test(c)) ruins.push(`${f}: ${c}`);
      }
    }
    expect(ruins).toEqual([]);
  });

  it("os avisos do topo não usam branco nem preto fixo", () => {
    const ruins: string[] = [];
    for (const f of [
      "components/app/ConexaoCaidaBanner.tsx",
      "components/app/EmailNaoConfirmadoBanner.tsx",
      "components/app/ExclusaoProgramadaBanner.tsx",
      "components/app/ImpersonateBanner.tsx",
    ]) {
      const fonte = fs.readFileSync(path.join(RAIZ, f), "utf8");
      const m = fonte.match(/\b(?:bg|text|border)-(?:white|black)\b[^\s"'`]*/g);
      if (m) ruins.push(`${f}: ${m.join(", ")}`);
    }
    expect(ruins).toEqual([]);
  });
});
