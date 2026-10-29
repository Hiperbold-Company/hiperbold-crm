# Prova pela tela: lote de 29/10/2026

A prova rodou no ambiente local, com `pnpm build` e `pnpm start` na porta 3300 e o Supabase local. Ela usou a organização fictícia "Clínica Sorriso Demo" (`demo-site`), em que nomes e telefones são inventados. As medidas estão em [medidas.json](medidas.json).

| # | Item | Resultado medido | Prova |
|---|---|---|---|
| 1 | Página de vendas com o nome Hiperbold CRM | o título é "Hiperbold CRM · CRM com WhatsApp e agentes de IA"; "HiperCRM" não aparece nenhuma vez no texto visível; o link do plano mais alto é `/signup?plano=scale` | [página](01-pagina-de-vendas.png) |
| 2 | "Eventos manuais" vira botão com dropdown | o botão mostra "Eventos manuais: qualquer" e mede 32 px de altura, como os outros; escolher "maior que" e 1 muda o rótulo para "Eventos manuais > 1" e a URL para `?eventos=gt:1` | [botão](02-eventos-manuais-botao.png), [dropdown](03-eventos-manuais-dropdown.png) |
| 3 | Colunas de UTM em Contatos | o diálogo oferece as 5 colunas de UTM; com "UTM origem" e "UTM campanha" marcadas, 25 linhas mostram o valor vindo do negócio mais recente; a escolha continua depois de recarregar | [diálogo](04-contatos-personalizar-utm.png), [lista](05-contatos-colunas-utm.png) |
| 4 | Radar só até 90 dias | um negócio aberto parado há 200 dias, criado na org fictícia para esta prova, não aparece no Radar; os recentes aparecem (13 críticos, 10 em risco) | [radar](06-radar.png) |
