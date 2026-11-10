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
 *  2. com a versão 2 de `pro`, `max` e `escale` no `supabase/baseline.sql` (a migration
 *     1001 a semeia num loop de `values`; vale a ÚLTIMA ocorrência, porque o arquivo é
 *     aplicado inteiro e em ordem). A comparação é OBRIGATÓRIA: se o parser não achar
 *     os três códigos, o teste reprova em vez de passar vazio.
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
  const bloco = blocos[0]?.[1];
  if (bloco === undefined) throw new Error(`${arquivo}: bloco #planos-dados ausente`);
  return JSON.parse(bloco) as DadosDaPagina;
}

/**
 * Preços da versão 2 como o BANCO os grava: a migration 1001 os semeia num loop
 * (`for v in select * from (values ('pro', 'Pro', mensal, semestral, anual, jsonb_build_object(...)), ...)
 * as t(code, nome, mensal, semestral, anual, limites)`), não por `insert` literal.
 * Vale a ÚLTIMA ocorrência no arquivo, porque ele é aplicado inteiro e em ordem.
 */
function precosDaV2NoBaseline(): Record<string, Precos> {
  const sql = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
  const fim = sql.lastIndexOf("as t(code, nome, mensal, semestral, anual, limites)");
  if (fim < 0) return {};
  const inicio = sql.lastIndexOf("select * from (values", fim);
  if (inicio < 0) return {};
  const bloco = sql.slice(inicio, fim);
  const achados: Record<string, Precos> = {};
  for (const m of bloco.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*jsonb_build_object/g)) {
    achados[m[1] as string] = {
      monthly: Number(m[2]),
      semiannual: Number(m[3]),
      yearly: Number(m[4]),
    };
  }
  return achados;
}

const BASELINE_V2 = precosDaV2NoBaseline();

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

  it("bate com a versão 2 do catálogo no baseline.sql (obrigatório)", () => {
    // OBRIGATÓRIO: se o parser não acha os três códigos, o teste reprova em vez de passar vazio.
    expect(Object.keys(BASELINE_V2).sort(), "v2 de pro, max e escale lida do baseline.sql").toEqual(["escale", "max", "pro"]);
    for (const plano of dados.planos) {
      const codigoNoCatalogo = CODIGO_NO_CATALOGO[plano.codigo] ?? plano.codigo;
      expect(plano.precos, `${arquivo} · ${plano.codigo} vs baseline v2`).toEqual(BASELINE_V2[codigoNoCatalogo]);
    }
  });
});

describe("o link de assinatura leva plano e ciclo", () => {
  it.each(["index.html", "precos/index.html"])("%s: três botões Assinar com plano e ciclo anual", (arquivo) => {
    const html = readFileSync(join(RAIZ, "public/site", arquivo), "utf8");
    const links = [...html.matchAll(/href="(\/signup\?plano=[^"]+)"/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
    expect(links).toEqual([
      "/signup?plano=pro&ciclo=yearly",
      "/signup?plano=max&ciclo=yearly",
      "/signup?plano=scale&ciclo=yearly",
    ]);
  });
});
