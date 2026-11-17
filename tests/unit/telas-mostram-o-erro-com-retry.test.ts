/**
 * As três telas que ganharam o estado de erro único (17/11/2026) continuam
 * ligadas a ele, com retry. O componente em si é provado em
 * erro-com-retry.test.tsx; aqui a prova é de que ninguém voltou a trocar o
 * erro por "lista vazia" — o defeito original: falha de rede parecia
 * "você não tem contatos".
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const ler = (f: string) => fs.readFileSync(path.join(RAIZ, f), "utf8");

describe("as telas mostram o erro com retry, não a lista vazia", () => {
  it.each([
    "app/app/contacts/_client.tsx",
    "app/app/automacoes/_components/AutomacoesList.tsx",
    "app/app/metrics/_components/AbaOrigens.tsx",
  ])("%s usa <ErroComRetry onRetry=…>", (f) => {
    const fonte = ler(f);
    expect(fonte).toMatch(/import \{ ErroComRetry \} from "@\/components\/empty\/ErroComRetry"/);
    expect(fonte).toMatch(/<ErroComRetry[\s\S]{0,400}?onRetry=\{/);
  });

  it("Contatos só troca pela tela de erro quando não há dado nenhum", () => {
    expect(ler("app/app/contacts/_client.tsx")).toMatch(/isError && !q\.data/);
  });

  it("Automações com dado carregado mostra a faixa de erro e mantém a lista", () => {
    const fonte = ler("app/app/automacoes/_components/AutomacoesList.tsx");
    expect(fonte).toMatch(/falhou && todas\.length > 0[\s\S]{0,200}faixa-erro-automacoes/);
    expect(fonte).toMatch(/falhou && todas\.length === 0[\s\S]{0,120}<ErroComRetry/);
  });
});
