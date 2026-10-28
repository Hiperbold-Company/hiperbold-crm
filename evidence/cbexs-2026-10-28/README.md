# Prova pela tela: ajustes CBEXS de 28/10/2026

Prova feita no ambiente local: `pnpm build` + `pnpm start` na porta 3300, com Supabase local e as migrations 0977–0983 aplicadas. O login foi `oliveira@hiperbold.com.br`, na organização CBEXS. As medidas estão em [medidas.json](medidas.json).

| # | Ajuste | Resultado | Prova |
|---|---|---|---|
| 1 | Filtro "Campo" acha o valor no negócio | `utm_source = search_ads` trouxe 480 contatos, igual ao banco | [prova](01-campo-utm-prova.png), [search_ads](01-campo-utm-search-ads.png) |
| 2 | Filtro Funil com várias etapas | 2 etapas do FUTURO 2027 trouxeram 12 contatos, igual ao banco; chip "› 2 etapas" | [popover](02-funil-etapas-popover.png), [resultado](02-funil-duas-etapas.png) |
| 3 | Personalizar colunas, salvo por usuário | contador 7/12 → 9/12; a escolha volta igual depois de recarregar | [diálogo](03-colunas-dialogo.png), [recarregado](03-colunas-apos-recarregar.png), [reaberto](03-colunas-dialogo-reaberto.png) |
| 4 | Diálogo "Editar contato" cabe na tela | em 1366×768: top 38,4 e bottom 729,6; Salvar e Cancelar visíveis | [1366×768](04-editar-contato-1366x768.png) |
| 5 | Filtro "Eventos manuais" | "maior que 1" deixa só o negócio com 3 notas | [filtro](05-eventos-manuais-maior-que-1.png) |
| 6 | Perda em lote com motivo | a janela abre antes; os 3 negócios vão para Perdido com `lost_reason` | [janela](06-perda-em-lote-janela-motivo.png), [depois](06-perda-em-lote-depois.png) |
| 7 | Criar tarefa no painel do negócio e sino | a tarefa aparece no painel; a vencida aparece no sino | [formulário](07-tarefa-form.png), [vencida](07-tarefa-form-vencida.png), [painel](07-tarefas-no-painel.png), [sino](07-sino-de-tarefas.png) |
| 8 | Atividades filtradas por atendente | 14 → 12 acontecimentos; `?atendente=` na URL | [todos](08-atividades-todos.png), [um atendente](08-atividades-um-atendente.png) |
| 9 | Desempenho como BI | as 4 abas mostram números; os filtros de funil e atendente funcionam | [Negócios](09-desempenho-negocios.png), [Origens](09-desempenho-origens.png), [Atendimento](09-desempenho-atendimento.png), [Atrito](09-desempenho-atrito.png), [funil](09-desempenho-filtro-funil.png), [atendente](09-desempenho-filtro-atendente.png) |

Achado fora do lote: `GET /api/v1/leads/at-risk` responde 500 no quadro do funil da organização CBEXS local. A causa provável é `radar_agenda_indisponivel`, e o código dessa rota não foi tocado neste lote.
