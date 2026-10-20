# Prova pela tela: lista de etiquetas da empresa no Inbox e na ficha do negócio

Ambiente: `next build` + `next start` na porta 3217 contra o Supabase local, organização "Clínica
Exemplo", dados fictícios. Vocabulário cadastrado em `organizations.settings.tags` com 13 etiquetas
fictícias em 4 grupos (um deles sem descrição, que vai para "Outras"). Usuário `prova.ficha@exemplo.com.br`.

- `01-inbox-lista-de-etiquetas.png`: botão "Tags do contato" aberto no Inbox. Lista agrupada ("Origem do
  lead", "Situação do paciente", ...), bolinha de cor, "Novo Paciente" já marcada porque o contato tem
  `novo paciente`. A lista rola (altura máxima de 224 px): os outros grupos ficam abaixo.
- `02-inbox-marcada-e-busca.png`: depois de marcar "Instagram" (PATCH 200 na hora; o chip `instagram` entrou
  no contato) e de digitar `indicacao` na busca: só "Indicação" aparece (sem acento, sem caixa), e como a
  etiqueta existe não é oferecido "Criar etiqueta".
- `03-ficha-do-negocio-seletor.png`: ficha do negócio com o campo "Tags" trocado pela mesma lista. Na prova,
  "Instagram" foi marcada e "Novo Paciente" desmarcada: nada gravou ao clicar; o "Salvar" enviou um único
  PATCH `{"tags":["Google Ads","Instagram"]}` (200) e o banco ficou com essas duas.
