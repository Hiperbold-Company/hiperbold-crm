/**
 * Os vínculos `on delete restrict` que apontam para `contacts` e que a exclusão
 * NÃO apaga de propósito — a lista que a lixeira de uma linha
 * (`deleteContactHandler`) e a exclusão em lote consultam ANTES do primeiro DELETE.
 *
 * O histórico completo da decisão (medido em `supabase/baseline.sql`, issue #752)
 * está no comentário de `deleteContactHandler` em `app/api/v1/contacts/_handler.ts`.
 * Tabela nova com RESTRICT para `contacts` entra aqui como uma linha, e vale para as
 * duas portas de uma vez.
 */
export const VINCULOS_RESTRICT_NAO_APAGADOS: ReadonlyArray<{ tabela: string; rotulo: string }> = [
  { tabela: "calendar_appointments", rotulo: "compromisso(s) na agenda" },
];
