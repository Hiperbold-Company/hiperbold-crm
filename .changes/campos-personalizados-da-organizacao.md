---
impacto: exige_acao
secao: adicionado
titulo: Campos personalizados da empresa, de contato e de negócio, numa tela só
---

Os campos personalizados passam a ser da empresa, em dois níveis: contato e negócio. A tela nova fica em Configurações › Campos Personalizados, com uma lista para Contatos e outra para Negócios, e cada campo se cria, edita e exclui num diálogo com as abas Campo, Tipo de dado, Avançado e Estatísticas (registros preenchidos, taxa de preenchimento, registros vazios, criado em e última edição). Um campo de negócio vale para todos os funis. Em Etapas do funil fica só a escolha de quais campos são obrigatórios em cada etapa, ao ganhar ou ao perder. Criar, editar e excluir campos é de administrador. Campo marcado como visível só para administradores sai, com o valor, só para administradores nas telas e exportações, e nunca vai para o agente de IA, para as variáveis das automações, para o texto dos follow-ups e das campanhas nem para as variáveis dos modelos do WhatsApp. Quem não é administrador também não filtra a lista de contatos por esse campo. Isso não é sigilo: quem tem acesso ao banco pela API continua lendo o valor. O campo restrito também fica de fora da decisão por IA das automações, das ferramentas MCP de negócio usadas pelo agente e das variáveis do follow-up da IA. As condições das automações e o webhook de saída (a ação que chama uma URL externa) continuam vendo e enviando o valor completo, porque quem os configura é administrador. A dica de ajuda aparece debaixo do nome do campo no formulário. Na atualização, os campos que cada funil já tinha viram campos da empresa automaticamente: a mesma chave em vários funis vira um campo só e vale a do funil mais antigo. A mesma chave usada num funil como campo de contato e em outro como campo de negócio vira dois campos, e o segundo ganha uma chave nova com os valores copiados. Nenhum valor já preenchido se perde, e a lista que cada funil tinha fica guardada como cópia. Excluir um campo tira ele das telas e mantém os valores guardados nos registros.


Se a imagem for revertida para uma versão anterior, os campos dos funis só voltam a ser editáveis quando a versão nova for religada.

## Requer atenção

- O DELETE de `/api/v1/pipelines/{id}/fields/{key}` e a ferramenta `crm_delete_pipeline_field`
  agora removem o campo da empresa inteira, de todos os funis, e não só do funil do caminho. Os
  valores continuam nos registros. Se a sua integração apaga um campo de um funil esperando que os
  outros funis o mantenham, ela passa a tirá-lo de todos.
- O PATCH de `/api/v1/pipelines/{id}/config` (e a ferramenta `crm_update_pipeline_config`) com
  `fields` passa a responder 422 quando a empresa já tem os campos da empresa. Para criar, alterar
  ou remover um campo, use `POST /api/v1/pipelines/{id}/fields` e
  `PATCH`/`DELETE /api/v1/pipelines/{id}/fields/{key}` (ou as ferramentas
  `crm_create_pipeline_field`, `crm_update_pipeline_field` e `crm_delete_pipeline_field`). No
  `config` do funil fica só a obrigatoriedade por etapa (`campos_obrigatorios`).
