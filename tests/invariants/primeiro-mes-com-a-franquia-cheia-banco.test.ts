/**
 * Migration 0956 (decisão do dono, 15/10/2026): o mês parcial em que o plano começa leva o teto
 * INTEIRO de tokens, sem proporção aos dias restantes; os meses seguintes seguem como sempre.
 * Provado no Postgres real, olhando o que a tela lê (billing_token_wallets.creditado) e o
 * livro-caixa.
 *
 * Roda via `pnpm test:db tests/invariants/primeiro-mes-com-a-franquia-cheia-banco.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const U = (n: number) => `0956a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CICLO = `public.fn_billing_ciclo_de(now())`;
const TETO = "3000000";

/** Linhas marcadas com SONDA| (uma por linha), dentro de um begin/rollback. */
function sonda(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((l) => l.startsWith("SONDA|"))
    .map((l) => l.slice(6));
}

const prepara = (org: string, slug: string, inicio: string) => `
  insert into public.organizations (id, slug, legal_name, display_name) values ('${org}', '${slug}', 'X', 'X');
  select public.fn_billing_trocar_plano('${org}', 'max', null);
  update public.billing_contracts set status = 'ativa', current_period_start = ${inicio},
    current_period_end = now() + interval '20 days' where organization_id = '${org}';`;
// Período pago começando no dia 15 do mês civil corrente (America/Sao_Paulo): o caso do relato.
const DIA_15 = `(${CICLO} + 14)::timestamp at time zone 'America/Sao_Paulo'`;
const conceder = (org: string, ciclo = CICLO) =>
  `select public.fn_billing_garantir_concessoes('${org}', ${ciclo});`;
const carteira = (org: string, ciclo = CICLO) => `
  select 'SONDA|' || coalesce((select creditado::text from public.billing_token_wallets
    where organization_id = '${org}' and fonte = 'plano' and ciclo = ${ciclo}), 'sem-carteira');`;
const livro = (org: string) => `
  select 'SONDA|' || coalesce((select sum(tokens)::text from public.billing_token_ledger
    where organization_id = '${org}' and fonte = 'plano'), '0');`;

describe("0956: primeiro mês (parcial) com a franquia cheia", () => {
  it("plano Max com período começando no dia 15: carteira e livro-caixa levam o teto inteiro, uma vez só", () => {
    const [antes, carteiraUma, livroUma, carteiraDuas, livroDuas] = sonda(`
      ${prepara(U(1), "p956-max", DIA_15)}
      select 'SONDA|' || (public.fn_billing_limites_efetivos('${U(1)}') ->> 'tokens_ia_mes');
      ${conceder(U(1))} ${carteira(U(1))} ${livro(U(1))}
      ${conceder(U(1))} ${carteira(U(1))} ${livro(U(1))}`);
    expect(antes).toBe(TETO);
    expect(carteiraUma).toBe(TETO);
    expect(livroUma).toBe(TETO);
    // idempotente: conceder de novo não soma
    expect(carteiraDuas).toBe(TETO);
    expect(livroDuas).toBe(TETO);
  });

  it("o mês seguinte segue igual: teto inteiro, em linha própria (não soma com o anterior)", () => {
    const [mesAtual, proximo, linhas] = sonda(`
      ${prepara(U(2), "p956-seg", DIA_15)}
      ${conceder(U(2))} ${carteira(U(2))}
      ${conceder(U(2), `(${CICLO} + interval '1 month')::date`)} ${carteira(U(2), `(${CICLO} + interval '1 month')::date`)}
      select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${U(2)}' and chave like 'plano:%';`);
    expect(mesAtual).toBe(TETO);
    expect(proximo).toBe(TETO);
    expect(linhas).toBe("2");
  });

  it("controle negativo: contrato atrasado continua sem ganhar o ciclo (a regra de contrato em dia não mudou)", () => {
    const [carteiraAtrasada] = sonda(`
      ${prepara(U(3), "p956-atr", DIA_15)}
      update public.billing_contracts set status = 'atrasada' where organization_id = '${U(3)}';
      ${conceder(U(3))} ${carteira(U(3))}`);
    expect(carteiraAtrasada).toBe("sem-carteira");
  });
});

describe("0956: correção da concessão proporcional já gravada no ciclo corrente", () => {
  // Reproduz a migration aplicada sobre uma organização que já recebeu a franquia proporcional
  // (1.645.161 = 3.000.000 x 17/31 em outubro): extrai o bloco `do $corrige$` do arquivo da migration.
  const corpoDoBloco = (): string => {
    const arquivo = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../supabase/migrations/20261015100000_0956_primeiro_mes_com_a_franquia_cheia.sql",
      ),
      "utf8",
    ) as string;
    const i = arquivo.indexOf("do $corrige$");
    return arquivo.slice(i);
  };
  const diasDoMes = `((${CICLO} + interval '1 month')::date - ${CICLO})`;

  it("completa até o teto o que foi concedido proporcional, na carteira e no livro-caixa, e não duplica ao reaplicar", () => {
    const [prop, depois, livroDepois, depoisDeNovo, livroDeNovo] = sonda(`
      ${prepara(U(11), "p956-corrige", DIA_15)}
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
        values ('${U(11)}', 'plano', (${TETO}::bigint * (${diasDoMes} - 14)) / ${diasDoMes}, 'plano:' || to_char(${CICLO}, 'YYYY-MM-DD'));
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values ('${U(11)}', 'plano', ${CICLO}, (${TETO}::bigint * (${diasDoMes} - 14)) / ${diasDoMes}, 0);
      ${carteira(U(11))}
      ${corpoDoBloco()}
      ${carteira(U(11))} ${livro(U(11))}
      ${corpoDoBloco()}
      ${carteira(U(11))} ${livro(U(11))}`);
    expect(Number(prop)).toBeLessThan(Number(TETO));
    expect(depois).toBe(TETO);
    expect(livroDepois).toBe(TETO);
    expect(depoisDeNovo).toBe(TETO);
    expect(livroDeNovo).toBe(TETO);
  });

  it("não mexe em quem recebeu outro valor (concessão manual) nem em quem já tinha mês anterior", () => {
    const [manual, comHistorico] = sonda(`
      ${prepara(U(12), "p956-manual", DIA_15)}
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
        values ('${U(12)}', 'plano', 1234, 'plano:' || to_char(${CICLO}, 'YYYY-MM-DD'));
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values ('${U(12)}', 'plano', ${CICLO}, 1234, 0);
      ${prepara(U(13), "p956-hist", DIA_15)}
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave) values
        ('${U(13)}', 'plano', ${TETO}, 'plano:2000-01-01'),
        ('${U(13)}', 'plano', 1234, 'plano:' || to_char(${CICLO}, 'YYYY-MM-DD'));
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values ('${U(13)}', 'plano', ${CICLO}, 1234, 0);
      ${corpoDoBloco()}
      ${carteira(U(12))} ${carteira(U(13))}`);
    expect(manual).toBe("1234");
    expect(comHistorico).toBe("1234");
  });
});
