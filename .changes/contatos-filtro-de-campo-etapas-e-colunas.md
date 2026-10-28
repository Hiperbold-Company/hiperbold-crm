---
impacto: capacidade_nova
secao: adicionado
titulo: Contatos — filtro de campo acha o valor do negócio, várias etapas no filtro de funil e colunas personalizadas
---

O filtro "Campo" da tela de Contatos passou a procurar, por padrão, no cadastro do contato e nos negócios dele (respeitando o funil escolhido). Antes ele olhava só o contato, e um campo como `utm_source`, que a captação grava no negócio, nunca era achado. Dá para restringir a "Do contato" ou "Do negócio".

O filtro "Funil" aceita várias etapas ao mesmo tempo: aparecem os contatos com negócio em qualquer das etapas marcadas.

O botão "Personalizar colunas" deixa cada pessoa escolher quais colunas a lista mostra (até 12, incluindo data de entrada, origem, aniversário, última mensagem e campos personalizados do contato) e em que ordem. A escolha fica salva no servidor, por usuário, e "Restaurar padrão" volta às colunas de sempre. A atualização cria a tabela `user_preferences` sozinha; nada a fazer na VPS.
