# Admin › Tenants: "Excluir organização" (tenant suspenso)

Prova pela tela, em 20/10/2026: `next build` + `next start` (porta 3300) sobre o Supabase local, logado como um
platform admin fictício (`qa-excluir-tenant@example.test`, escopo `full`, sem MFA exigido). Dois tenants fictícios
criados só para esta prova: `qa-excluir-ativa` (ativo) e `qa-excluir-suspensa` (suspenso há 5 dias). Nenhuma
organização real do banco local foi tocada.

| Print | O que mostra |
|---|---|
| `1-lista-acao-so-no-suspenso.png` | Lista de tenants: "Excluir organização" (vermelho) só na linha do suspenso; ativo e demais só têm "Ver". |
| `2-modal-programar-ou-excluir-agora.png` | O modal: programar (data sugerida 13/01/2027 = suspensão + 90 dias de guarda, com "Vai valer") e excluir agora (botão desabilitado até digitar o slug). |
| `3-exclusao-programada.png` | Depois de "Programar exclusão": faixa "Exclusão já programada para 13/01/2027" com "Cancelar exclusão" e botão "Reprogramar exclusão". Linha em `org_exclusoes_programadas` (origem manual, 2027-01-13 05:00 UTC). |
| `4-slug-digitado-botao-habilitado.png` | Slug exato digitado: "Excluir agora" habilitado. |
| `5-tenant-some-da-lista.png` | Depois de excluir: aviso "Organização excluída.", lista de 8 para 7 tenants. No banco, `api_audit_log` ganhou `org.data_purged` (forcada: true). |
| `6-pagina-do-tenant-ativo-desabilitado.png` | Página do tenant ativo: "Excluir organização" desabilitado com a dica "Suspenda antes de excluir". |

Observação de ambiente: o banco local estava sem as migrations 0959 e 0964 (tabela e funções de exclusão). Elas
foram aplicadas ao Supabase local (as do repositório, sem alteração) para a prova.
