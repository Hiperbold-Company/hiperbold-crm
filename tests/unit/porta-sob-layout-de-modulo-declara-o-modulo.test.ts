/**
 * Porta que leva a 404 é porta que não devia aparecer.
 *
 * Um `layout.tsx` que chama `notFound()` quando `moduloLigado(..., X)` é falso faz a tela
 * inteira (e tudo que mora sob a pasta) não existir com o módulo X desligado. Toda entrada
 * do `NAV_CATALOG` cuja rota fica sob esse layout tem de declarar `modulo: X`; senão a porta
 * aparece em Configurações, no ⌘K e no hub e abre uma página não encontrada.
 * Caso real: "Modelos de proposta" declarava só `capacidade`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_CATALOG, type NavMetadata } from "@/lib/navigation/catalogo";
import { permitidos } from "@/lib/navigation/interface";

const RAIZ = join(__dirname, "..", "..");
const APP = join(RAIZ, "app");
const CATALOGO = NAV_CATALOG as readonly NavMetadata[];

function layouts(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return layouts(caminho);
    return nome === "layout.tsx" ? [caminho] : [];
  });
}

/** Layouts que fazem `notFound()` quando um módulo opcional da instalação está desligado. */
const LAYOUTS_DE_MODULO = layouts(join(APP, "app")).flatMap((arquivo) => {
  const src = readFileSync(arquivo, "utf8");
  const m = src.match(/if\s*\(\s*!\s*\(\s*await moduloLigado\([^,]+,\s*"([a-z0-9_]+)"\s*\)\s*\)\s*\)\s*notFound\(\)/);
  if (!m) return [];
  const rota = "/" + arquivo.slice(APP.length + 1).replace(/\/layout\.tsx$/, "");
  return [{ rota, modulo: m[1]! }];
});

describe("porta sob layout de módulo declara o módulo", () => {
  it("controle: a varredura enxerga os layouts de módulo (senão o resto é vácuo)", () => {
    expect(LAYOUTS_DE_MODULO.map((l) => l.rota)).toContain("/app/settings/tenant/proposals");
    expect(LAYOUTS_DE_MODULO.length).toBeGreaterThanOrEqual(6);
  });

  it.each(LAYOUTS_DE_MODULO)("$rota exige o módulo $modulo em toda porta sob ela", ({ rota, modulo }) => {
    const portas = CATALOGO.filter((d) => d.href === rota || d.href.startsWith(rota + "/"));
    expect(portas.length).toBeGreaterThan(0);
    for (const porta of portas) expect(porta.modulo, porta.href).toBe(modulo);
  });
});

describe("Modelos de proposta: a porta segue o módulo da instalação e a capacidade da empresa", () => {
  const MODELOS = "/app/settings/tenant/proposals/modelos";
  const vistas = (
    modulos: Parameters<typeof permitidos>[2],
    capacidades: Parameters<typeof permitidos>[3],
  ) => permitidos(false, "admin", modulos, capacidades).map((d) => d.href);

  it("módulo desligado: a porta não aparece, mesmo com a capacidade ligada", () => {
    expect(vistas([], ["propostas"])).not.toContain(MODELOS);
  });

  it("módulo ligado e capacidade ligada: a porta aparece", () => {
    expect(vistas(["propostas"], ["propostas"])).toContain(MODELOS);
  });

  it("módulo ligado e capacidade desligada: a porta não aparece", () => {
    expect(vistas(["propostas"], [])).not.toContain(MODELOS);
  });
});
