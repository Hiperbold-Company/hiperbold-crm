/**
 * Migration 0998 (fork Hiperbold): o grant por coluna lê o catálogo NO PONTO em que roda.
 *
 * `contacts` (0967, sem cpf_hash/cpf_encrypted) e as três tabelas com token de webhook (0948)
 * não têm grant de tabela para o usuário: só coluna a coluna. Coluna acrescentada ao baseline
 * DEPOIS do bloco de grant nasce, na instalação nova, sem SELECT para `authenticated`, e o
 * PostgREST responde "permission denied for table contacts" a todo select que a pede. Foi o que
 * o merge do upstream de 04/11/2026 fez com `contacts.ai_opt_out` e `contacts.contact_type`:
 * 500 em criar e listar contatos e Inbox vazia no e2e, com o `test:db` verde (a segunda passada,
 * a de update, já encontra as colunas e cobre o defeito).
 *
 * Cerca: a última coluna acrescentada a cada tabela vem antes do último bloco da 0998.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const TABELAS = ["contacts", "channel_sessions", "webhook_sources", "tenant_integrations"];
const BLOCO = "$hb_0998_grants_por_coluna$;";

function ultimaColunaAcrescentada(tabela: string): number {
  const re = new RegExp(`alter table (?:if exists )?(?:only )?(?:"?public"?\\.)?"?${tabela}"?\\s[^;]*?add column`, "gi");
  // Sem `add column` (tenant_integrations hoje): vale a posição do `create table`.
  let ultimo = BASELINE.search(new RegExp(`create table (?:if not exists )?(?:"?public"?\\.)?"?${tabela}"?\\s`, "i"));
  for (const m of BASELINE.matchAll(re)) ultimo = Math.max(ultimo, m.index!);
  return ultimo;
}

describe("grant por coluna fica depois da última coluna de cada tabela", () => {
  const bloco = BASELINE.lastIndexOf(BLOCO);

  it("o bloco da 0998 existe no baseline (controle de vivacidade)", () => {
    expect(bloco).toBeGreaterThan(0);
  });

  for (const tabela of TABELAS) {
    it(`${tabela}: nenhuma coluna nova depois do grant`, () => {
      const ultima = ultimaColunaAcrescentada(tabela);
      expect(ultima, `o regex não achou nem create table nem add column de ${tabela}`).toBeGreaterThan(0);
      expect(
        ultima < bloco,
        `${tabela} ganha coluna depois do grant por coluna da 0998: na instalação nova ela nasce sem SELECT para o usuário. Mova o bloco $hb_0998_grants_por_coluna$ para depois dela (ou decida e escreva por que a coluna fica fechada).`,
      ).toBe(true);
    });
  }

  it("o controle negativo: sem o bloco no fim, contacts reprovaria", () => {
    // sonda-do-baseline: primeira-de-proposito — o controle mede o bloco ORIGINAL da 0967, no meio do arquivo.
    const antigo = BASELINE.indexOf("and a.attname not in ('cpf_hash', 'cpf_encrypted');");
    expect(antigo).toBeGreaterThan(0);
    expect(ultimaColunaAcrescentada("contacts")).toBeGreaterThan(antigo);
  });
});
