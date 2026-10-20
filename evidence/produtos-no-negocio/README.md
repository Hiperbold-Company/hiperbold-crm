# Produtos no negócio — prova pela tela (20/10/2026)

Ambiente: `next build` + `next start` (porta 3300), Supabase local (127.0.0.1:54322) com a migration 0972
aplicada, organização **Clínica Exemplo**, usuário administrador de teste, dados fictícios. O `.env.local`
copiado para a prova foi apagado depois. Navegador dirigido por Playwright (Chromium headless, 1280x900).

| Print | O que prova |
|---|---|
| `01-cadastro-valor-fixo.png` | Cadastro de produto com "Valor fixo" escolhido: o campo Preço de venda aparece. |
| `02-cadastro-valor-variavel.png` | "Valor variável" escolhido: o campo de preço some e a tela explica que o valor é definido em cada negócio e que a IA não cita preço. |
| `03-lista-fixo-e-variavel.png` | Lista do catálogo: o fixo mostra o preço, o variável mostra "Valor variável". |
| `04-configuracoes-com-produtos.png` | Hub de Configurações com a porta **Produtos** (seção Atendimento). A porta do CRM continua. |
| `05-ficha-sem-produtos.png` | Ficha do negócio sem produtos: seção "Produtos" vazia, Valor editável. |
| `06-adicionando-produto-fixo.png` | Produto fixo escolhido: valor unitário já vem com o preço do catálogo (150,00), editável; quantidade 2. |
| `07-adicionando-produto-variavel-valor-obrigatorio.png` | Produto variável escolhido: valor vazio, botão Adicionar desabilitado até digitar o valor. |
| `08-ficha-com-2-itens-valor-somado.png` | Ficha com 2 itens (2 × R$ 150,00 fixo; 1 × R$ 4.800,00 variável digitado). Total R$ 5.100,00 e o card do funil já mostra R$ 5.100. |
| `09-ficha-valor-somado-campo.png` | Campo Valor (R$) = 5100,00, em leitura, com "Soma dos produtos deste negócio". |
| `10-linha-do-tempo-produto-adicionado.png` | Linha do tempo com "Produto adicionado" (sem valor em dinheiro no texto). |

Conferência no banco ao fim da prova: `crm_leads.value_cents = 510000`; itens `Consulta de avaliação 2 × 15000`
e `Projeto sob medida 1 × 480000`; atividades `lead_product_added` com `reason` "Adicionou 2 × Consulta de avaliação".
