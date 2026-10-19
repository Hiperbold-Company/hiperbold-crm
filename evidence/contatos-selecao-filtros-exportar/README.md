# Contatos: seleção em lote, filtros ampliados e exportação em CSV

Prova pela tela, como um leigo faria: `next build` + `next start` (porta 3417), Supabase local
(127.0.0.1:54322, com a função da migration 0971 aplicada), organização Clínica Exemplo, logado como
gerente (`carla@exemplo.com.br`) e, para o print 10, como atendente (`bruno@exemplo.com.br`). Navegador
dirigido por Playwright. Dados fictícios: 40 contatos "Lote Teste NN" semeados só nessa organização (com
`cargo`/`empresa` no contato e `utm_source` em 12 negócios) e removidos ao fim. A organização CBEXS
(5.931 contatos) foi conferida antes e depois: intacta.

O roteiro está registrado em `log-da-prova.txt` (URLs, contagens, textos da faixa, do modal e dos toasts).

| Arquivo | O que mostra |
|---|---|
| `01-lista-com-caixas.png` | A lista do gerente com a coluna de caixas de seleção e a linha de filtros nova (Entrou no CRM, Última atividade, Funil, Campo). |
| `02a-filtro-entrou-e-funil-aberto.png` | "Entrou no CRM: Últimos 30 dias" ligado e o filtro de Funil aberto (funil "Consultas", etapa opcional). |
| `02b-filtro-campo-aberto.png` | O filtro de campo personalizado aberto: do contato ou do negócio, campo, condição (contém / é igual a) e valor. |
| `03-filtros-aplicados-na-url.png` | Filtros combinados aplicados (30 dias + funil + `cargo contém diretora`): 6 contatos. A URL ficou `?criado=30d&funil=…&campo_escopo=contato&campo=cargo&campo_op=contem&campo_valor=diretora`. |
| `03b-campo-do-negocio.png` | Campo do NEGÓCIO (`utm_source contém google`): traz o contato que tem algum negócio com o valor (7 contatos). O botão do filtro agora diz "contém", sem símbolo. |
| `04-pagina-selecionada-faixa-selecionar-todos.png` | Cabeçalho marcado: barra "25 selecionados" e a faixa "Os 25 desta página estão selecionados. Selecionar todos os 58 contatos do filtro". |
| `05-todos-do-filtro-selecionados.png` | Depois de clicar na faixa: "58 selecionados", resolvido no servidor (nenhum id vai na requisição). |
| `06-modal-excluir-digitar-quantidade.png` | "Excluir 58 contatos?": acima de 50 o botão Excluir fica desabilitado até digitar a quantidade. |
| `07-exportacao-concluida.png` | Toast "58 contatos exportados (contatos-2026-10-19.csv)" depois de Exportar CSV com todos do filtro (a tela manda o total que viu, e o servidor recusa com 409 se mudou). |
| `contatos-2026-10-19.csv` | O arquivo baixado (UTF-8 com BOM `ef bb bf`, vírgula, CRLF). Só dados fictícios. |
| `csv-primeiras-linhas.txt` | As primeiras linhas do CSV: colunas Nome, E-mail, Telefone, Tags, Origem, Entrou no CRM, Última atividade, Funis e etapas, e os campos personalizados. Sem CPF nem outros documentos. |
| `08-modal-excluir-3-contatos.png` | Seleção de 3 linhas e o modal "Excluir 3 contatos?" (abaixo de 50, sem digitar). |
| `09-apos-excluir.png` | Depois de confirmar: toast "3 contatos excluídos." e a lista atualizada. A exclusão passou pela função `fn_excluir_contatos_em_lote` (tudo-ou-nada por bloco). |
| `10-atendente-sem-selecao-em-lote.png` | O atendente: sem caixas de seleção e sem barra de lote (0 e 0 no log), e com a lixeira de UM contato em cada linha, como antes. Excluir em lote e exportar são só de gerente e administrador. |

Conferido no banco depois da prova: uma linha `contacts.bulk_deleted` (modo `ids`, 3 excluídos, 0 ignorados)
e uma `contacts.exported` (modo `filtro`, 58 linhas) em `api_audit_log`, sem texto pessoal no metadata; os
negócios dos contatos excluídos ficaram com `contact_id` nulo (`ON DELETE SET NULL`, igual à lixeira de uma
linha).
