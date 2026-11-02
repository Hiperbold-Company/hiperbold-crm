# Editar fonte de captação: prova pela tela

Ambiente: `pnpm build && pnpm start -p 3310` (produção) contra o Supabase local, logado como o dono da org demo. O Playwright dirigiu o navegador: criou uma fonte pela tela, editou, reabriu e excluiu.

| Arquivo | O que mostra |
|---|---|
| `00-como-conectar-elementor.png` | "Como conectar no seu caso" com o texto novo do Elementor Pro, do Contact Form 7, do Fluent Forms e do WPForms |
| `01-dialogo-aberto.png` | "Editar" abre o diálogo com os valores gravados |
| `02-dialogo-preenchido.png` | Nome, etapa, página de obrigado e campo do telefone (`form_fields[phone], contato_celular`) alterados, com a lista dos nomes que o CRM já reconhece sozinho |
| `03-salvo-detalhe-atualizado.png` | Depois de salvar: aviso "Fonte atualizada.", e o título do detalhe e o cartão da lista já com o nome novo, sem recarregar a página |
| `04-confirmar-exclusao.png` | A confirmação diz o que acontece com o endereço, com os leads e com o histórico. O texto do interruptor diz o que acontece com a fonte pausada |
| `05-excluida.png` | Depois de excluir |

Ao reabrir o diálogo, os valores salvos voltaram: telefone `form_fields[phone], contato_celular` e obrigado `https://example.com/obrigado`.
