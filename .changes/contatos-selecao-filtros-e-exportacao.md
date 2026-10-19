---
impacto: capacidade_nova
secao: adicionado
titulo: Contatos - seleção em lote, filtros por data, funil e campo, e exportação em CSV
---

Para gerentes e administradores, a tela de Contatos ganhou caixas de seleção (por linha, por página e
"selecionar todos os N contatos do filtro", como no Gmail) e uma barra de ações com Excluir e Exportar
CSV; o atendente segue com a lixeira de um contato por vez. A exclusão em lote faz o mesmo que a
lixeira de cada linha (apaga o contato e as conversas e mensagens dele; contato com compromisso na
agenda, anonimizado ou já mesclado não é excluído), em blocos de tudo-ou-nada (nenhum contato fica com
o histórico apagado e a ficha de pé), pede confirmação com a quantidade exata e, acima de 50, exige
digitar o número. A atualização aplica uma função nova no banco (migration 0971), sem ação manual.
Novos filtros, combináveis com a busca e guardados na URL: quando entrou no
CRM e última atividade (Hoje, 7 dias, 30 dias, Este mês ou de/até, no fuso da organização), funil e
etapa em que o contato tem negócio, e campo personalizado do contato ou do negócio (contém ou igual).
A exportação gera um CSV em UTF-8 que abre direto no Excel em português, sem CPF nem outros documentos,
e fica registrada na auditoria. Excluir em lote e exportar têm limite de chamadas por usuário.
