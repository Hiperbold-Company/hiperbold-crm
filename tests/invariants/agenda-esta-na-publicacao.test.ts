import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * A AGENDA FORA DA PUBLICAÇÃO DE REALTIME — ENQUANTO NINGUÉM A ASSINAR.
 *
 * Até a migration 1000 (fork Hiperbold) este arquivo exigia
 * `calendar_appointments` DENTRO da publicação: a 0183 a publicou para o hook de
 * realtime da grade da agenda, e esse hook nunca foi escrito. Publicada sem
 * consumidor, cada escrita só custava decodificação no Realtime. A 1000 a tira,
 * e a trava contra "alguém passou a assinar" mora em
 * `tests/unit/realtime-assinatura-tem-publicacao.test.ts`
 * (`SEM_CONSUMIDOR_CONHECIDO`): no dia em que uma tela assinar, aquele teste
 * reprova e a tabela volta à publicação — e esta asserção se inverte junto.
 *
 * As outras duas continuam valendo pelo motivo de sempre: `calendar_external_events`
 * é espelho reescrito em lote (o "pulso que mente"), e `calendar_connections`
 * guarda token e não tem consumidor.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function publicadas(): string[] {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c",
      "select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by 1"],
    { encoding: "utf8" },
  ).trim().split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("a agenda fora da publicação de realtime", () => {
  it("a sonda enxerga a publicação (guarda de vacuidade)", () => {
    // Publicação inexistente devolveria lista vazia, e as duas asserções abaixo
    // passariam medindo o vácuo — uma delas por acidente.
    expect(publicadas().length).toBeGreaterThan(5);
  });

  it("calendar_appointments NÃO publica — nenhum código a assina (1000)", () => {
    expect(publicadas()).not.toContain("calendar_appointments");
  });

  it("calendar_external_events NÃO publica — espelho em lote seria pulso que mente", () => {
    expect(publicadas()).not.toContain("calendar_external_events");
  });

  it("calendar_connections NÃO publica — guarda token e não tem consumidor", () => {
    expect(publicadas()).not.toContain("calendar_connections");
  });
});
