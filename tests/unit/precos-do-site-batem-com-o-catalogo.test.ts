import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * OS PREÇOS DA PÁGINA DE VENDAS BATEM COM O CATÁLOGO.
 *
 * `/` e `/precos` são HTML exportado do site Astro (`public/site/`, ver
 * `hiperbold/site-de-vendas.md`). Os preços vivem em `src/data/planos.ts` do site e
 * vão embutidos UMA vez em cada página, no bloco `<script type="application/json"
 * id="planos-dados">`. Este teste lê esse bloco do HTML que o CRM serve e o compara:
 *
 *  1. com a constante abaixo (os centavos decididos pelo dono do produto em 09/11/2026);
 *  2. com a versão 2 de `pro`, `max` e `escale` no `supabase/baseline.sql`, quando o
 *     baseline do worktree já a traz (vale a ÚLTIMA ocorrência, porque o arquivo é
 *     aplicado inteiro e em ordem).
 *
 * ATENÇÃO: a versão 2 do catálogo vem de outra unidade, em outro branch. Depois do
 * merge dela, a comparação com o baseline passa a ser OBRIGATÓRIA: `BASELINE_TEM_V2`
 * vira `true` sozinha quando o baseline traz a v2, e o teste reprova se ela divergir.
 * Quando a v2 já estiver na `main`, trocar a guarda por `expect(BASELINE_TEM_V2).toBe(true)`.
 *
 * O código do terceiro plano é `scale` no site e `escale` no catálogo (apelido em
 * `lib/auth/plano-escolhido.ts`).
 */

const RAIZ = process.cwd();

type Ciclo = "monthly" | "semiannual" | "yearly";
type Precos = Record<Ciclo, number>;

const ESPERADO: Record<string, Precos> = {
  pro: { monthly: 14900, semiannual: 79900, yearly: 139900 },
  max: { monthly: 29900, semiannual: 159900, yearly: 284900 },
  scale: { monthly: 44900, semiannual: 239900, yearly: 429900 },
};

const CODIGO_NO_CATALOGO: Record<string, string> = { pro: "pro", max: "max", scale: "escale" };

interface DadosDaPagina {
  cicloPadrao: string;
  planos: { codigo: string; precos: Precos }[];
}

function lerDados(arquivo: string): DadosDaPagina {
  const html = readFileSync(join(RAIZ, "public/site", arquivo), "utf8");
  const blocos = [...html.matchAll(/<script[^>]*id="planos-dados"[^>]*>([\s\S]*?)<\/script>/g)];
  expect(blocos, `${arquivo}: deve haver exatamente um bloco #planos-dados`).toHaveLength(1);
  return JSON.parse(blocos[0][1]) as DadosDaPagina;
}

/** Divide por vírgulas de nível zero, respeitando aspas simples e parênteses. */
function dividirNoNivelZero(texto: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let aspas = false;
  let atual = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      atual += c;
      if (c === "'") {
        if (texto[i + 1] === "'") atual += texto[++i];
        else aspas = false;
      }
      continue;
    }
    if (c === "'") aspas = true;
    if (c === "(") nivel++;
    if (c === ")") nivel--;
    if (c === "," && nivel === 0) {
      partes.push(atual.trim());
      atual = "";
      continue;
    }
    atual += c;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

/** Última linha `version = 2` de cada plano em `insert into public.billing_plans` do baseline. */
function precosDaV2NoBaseline(): Record<string, Precos> {
  const sql = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
  const achados: Record<string, Precos> = {};
  const inserts = sql.split(/insert\s+into\s+public\.billing_plans/i).slice(1);
  for (const bloco of inserts) {
    const colunas = /^\s*\(([^)]*)\)/.exec(bloco)?.[1].split(",").map((c) => c.trim());
    if (!colunas) continue;
    const idx = (re: RegExp) => colunas.findIndex((c) => re.test(c));
    const iCode = idx(/^code$/);
    const iVersion = idx(/^version$/);
    const iMes = idx(/^price_monthly_cents$/);
    const iSem = idx(/semi/);
    const iAno = idx(/^price_yearly_cents$/);
    if ([iCode, iVersion, iMes, iSem, iAno].some((i) => i < 0)) continue;
    const valores = bloco.slice(bloco.search(/\bvalues\b/i) + 6).split(/\bon\s+conflict\b|;/i)[0];
    for (const linha of valores.split(/\n(?=\s*\(')/)) {
      const interior = linha.trim().replace(/^\(/, "").replace(/\),?\s*$/, "");
      const campos = dividirNoNivelZero(interior);
      if (campos[iVersion] !== "2") continue;
      const codigo = campos[iCode]?.replace(/'/g, "");
      achados[codigo] = {
        monthly: Number(campos[iMes]),
        semiannual: Number(campos[iSem]),
        yearly: Number(campos[iAno]),
      };
    }
  }
  return achados;
}

const BASELINE_V2 = precosDaV2NoBaseline();
const BASELINE_TEM_V2 = ["pro", "max", "escale"].every((c) => BASELINE_V2[c]);

describe.each(["index.html", "precos/index.html"])("preços do site em public/site/%s", (arquivo) => {
  const dados = lerDados(arquivo);

  it("abre no ciclo anual", () => {
    expect(dados.cicloPadrao).toBe("yearly");
  });

  it("traz os três planos, na ordem Pro, Max, Scale", () => {
    expect(dados.planos.map((p) => p.codigo)).toEqual(["pro", "max", "scale"]);
  });

  it("os centavos de cada ciclo batem com os decididos pelo dono do produto", () => {
    for (const plano of dados.planos) {
      expect(plano.precos, `${arquivo} · ${plano.codigo}`).toEqual(ESPERADO[plano.codigo]);
    }
  });

  it("bate com a versão 2 do catálogo no baseline.sql (obrigatório quando a v2 está no baseline)", () => {
    if (!BASELINE_TEM_V2) return; // v2 ainda em outro branch; ver o cabeçalho do arquivo
    for (const plano of dados.planos) {
      expect(plano.precos, `${arquivo} · ${plano.codigo} vs baseline v2`).toEqual(
        BASELINE_V2[CODIGO_NO_CATALOGO[plano.codigo]],
      );
    }
  });
});

describe("o link de assinatura leva plano e ciclo", () => {
  it.each(["index.html", "precos/index.html"])("%s: três botões Assinar com plano e ciclo anual", (arquivo) => {
    const html = readFileSync(join(RAIZ, "public/site", arquivo), "utf8");
    const links = [...html.matchAll(/href="(\/signup\?plano=[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    expect(links).toEqual([
      "/signup?plano=pro&ciclo=yearly",
      "/signup?plano=max&ciclo=yearly",
      "/signup?plano=scale&ciclo=yearly",
    ]);
  });
});
