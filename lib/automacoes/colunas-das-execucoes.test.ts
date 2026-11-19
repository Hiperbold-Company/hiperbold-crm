/**
 * Cerca: toda consulta das automações a `followup_enrollments` só pede colunas
 * que existem no `baseline.sql` (o schema que a produção e o self-host têm).
 *
 * Por que existe: `execucoesDoDirectNaConversa` (uma-voz.ts) pedia `created_at`,
 * coluna que a tabela nunca teve (o nome é `started_at`). Os testes usam banco
 * de mentira e passavam; na produção, toda mensagem do Messenger e do Direct
 * do Instagram fazia o gatilho "Mensagem recebida" lançar erro e nenhuma
 * automação começava.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");

function colunasDoBaseline(tabela: string): Set<string> {
  const sql = fs.readFileSync(path.join(RAIZ, "supabase/baseline.sql"), "utf8");
  const cols = new Set<string>();
  const criar = new RegExp(
    `create table (?:if not exists )?(?:public\\.)?${tabela} \\(([\\s\\S]*?)\\n\\);`,
    "gi",
  );
  for (const m of sql.matchAll(criar)) {
    for (const linha of m[1]!.split("\n")) {
      const c = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(linha)?.[1]?.toLowerCase();
      if (c && !["constraint", "primary", "unique", "check", "foreign"].includes(c)) cols.add(c);
    }
  }
  const somar = new RegExp(
    `alter table (?:only )?(?:if exists )?(?:public\\.)?${tabela}\\s+add column (?:if not exists )?"?([a-z_][a-z0-9_]*)`,
    "gi",
  );
  for (const m of sql.matchAll(somar)) cols.add(m[1]!.toLowerCase());
  return cols;
}

function arquivosDasAutomacoes(): string[] {
  const dir = path.join(RAIZ, "lib/automacoes");
  const out: string[] = [];
  const andar = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) andar(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  };
  andar(dir);
  return out;
}

/** Colunas pedidas em `.select("...")` e `.order("...")` logo depois de `.from("followup_enrollments")`. */
function colunasPedidas(fonte: string): Array<{ coluna: string; trecho: string }> {
  const out: Array<{ coluna: string; trecho: string }> = [];
  for (const m of fonte.matchAll(/\.from\("followup_enrollments"\)([\s\S]{0,600})/g)) {
    // Para na próxima consulta, para não ler a cadeia de outra tabela.
    const cadeia = m[1]!.split(/\.from\(|await |\n\s*\n/)[0]!;
    const sel = /\.select\("([^"]*)"/.exec(cadeia)?.[1];
    if (sel) {
      for (const parte of sel.split(",")) {
        const p = parte.trim();
        if (!p || p === "*" || p.includes("(")) continue;
        // `apelido:coluna` → a coluna; `vars->a` → `vars`.
        const coluna = (p.includes(":") ? p.split(":")[1]! : p).split("->")[0]!.trim();
        out.push({ coluna, trecho: sel });
      }
    }
    for (const o of cadeia.matchAll(/\.order\("([a-z_]+)"/g))
      out.push({ coluna: o[1]!, trecho: `order ${o[1]}` });
  }
  return out;
}

describe("consultas das automações a followup_enrollments", () => {
  const existentes = colunasDoBaseline("followup_enrollments");

  it("o baseline foi lido (a cerca não passa no vazio)", () => {
    expect(existentes.has("started_at")).toBe(true);
    expect(existentes.has("status")).toBe(true);
  });

  it("nenhuma consulta pede coluna que a tabela não tem", () => {
    const faltando: string[] = [];
    for (const arquivo of arquivosDasAutomacoes()) {
      const fonte = fs.readFileSync(arquivo, "utf8");
      for (const { coluna, trecho } of colunasPedidas(fonte)) {
        if (!existentes.has(coluna))
          faltando.push(`${path.relative(RAIZ, arquivo)}: "${coluna}" (${trecho})`);
      }
    }
    expect(faltando).toEqual([]);
  });

  it("a cerca acusa a coluna inexistente (controle)", () => {
    const pedidas = colunasPedidas(
      '.from("followup_enrollments")\n.select("id, status, created_at")',
    );
    expect(pedidas.map((p) => p.coluna).filter((c) => !existentes.has(c))).toEqual(["created_at"]);
  });
});
