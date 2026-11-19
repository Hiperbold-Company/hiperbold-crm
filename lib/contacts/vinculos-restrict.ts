/**
 * Os vínculos `on delete restrict` que apontam para `contacts` e que a exclusão
 * NÃO apaga de propósito — a lista que a lixeira de uma linha
 * (`deleteContactHandler`) e a exclusão em lote consultam ANTES do primeiro DELETE.
 *
 * O histórico completo da decisão (medido em `supabase/baseline.sql`, issue #752)
 * está no comentário de `deleteContactHandler` em `app/api/v1/contacts/_handler.ts`.
 * Tabela nova com RESTRICT para `contacts` entra aqui como uma linha, e vale para as
 * duas portas de uma vez.
 *
 * A entrada de `crm_leads` NÃO é FK RESTRICT (a FK é `ON DELETE SET NULL`): é regra de negócio,
 * porque negócio em aberto sem contato é negócio sem lead. O `filtro` restringe a contagem às
 * linhas que barram (`status = 'open'`); negócio ganho/perdido não barra. Vale nas duas portas.
 */
export const VINCULOS_RESTRICT_NAO_APAGADOS: ReadonlyArray<{
  tabela: string;
  rotulo: string;
  filtro?: { coluna: string; valor: string };
}> = [
  { tabela: "calendar_appointments", rotulo: "compromisso(s) na agenda" },
  { tabela: "crm_leads", rotulo: "negócio(s) em aberto", filtro: { coluna: "status", valor: "open" } },
];
