# Prova pela tela: ficha do negócio, filtros de data e "quem move assume"

Ambiente: `next build` + `next start` na porta 3410 contra o Supabase local, organização "Clínica
Exemplo", dados fictícios (contatos e negócios "(fictícia)"), usuário `prova.ficha@exemplo.com.br`.

## Ficha: campos em dois blocos, linha do tempo do contato e evento manual

- `01-ficha-blocos-rastreamento-recolhido.png`: "Dados do lead" aberto e "Rastreamento" recolhido.
- `02-ficha-blocos-rastreamento-aberto.png`: o mesmo, com "Rastreamento" aberto (4/4 preenchidos).
- `03-linha-do-tempo-do-contato.png`: evento de outro funil, com "Em FUTURO 2026 · Maria Souza — Extensão 2026".
- `04-evento-manual-com-autor.png`: ligação registrada à mão e retroativa, com autor, data do evento e "registrado em".
- `00-kanban.png`: a lista de funis da organização.

## Regra "quem move um lead sem responsável passa a ser o responsável"

- `05-interruptor-desligado-por-padrao.png` e `06-interruptor-ligado.png`: o interruptor em Configurações › Distribuição de atendimento.
- `11-quadro-depois-de-mover.png` e `12-ficha-datas-responsavel-e-evento.png`: o negócio sem responsável movido de "Inscrito" para "Em contato" mostra o responsável e "Assumiu o negócio" na linha do tempo.

## Datas e filtros do quadro

- `07-quadro-card-movido-ha.png`: os cards com "movido hoje", "movido há 40 dias" etc.
- `08-filtro-criado-em-aberto.png`: "Criado em" aberto, com os atalhos e o período personalizado.
- `09-filtro-criado-7-dias-resultado.png`: "Criado em: Últimos 7 dias" aplicado (`?criado=7d`) e o resultado.
- `10-filtro-ultima-movimentacao-personalizado.png`: "Última movimentação" com período personalizado (`?mov_de=…`).
- `12-ficha-datas-responsavel-e-evento.png` também mostra "Criado em" e "Última movimentação" no cabeçalho da ficha.
