---
impacto: capacidade_nova
secao: adicionado
titulo: Produtos dentro do negócio, com valor fixo ou variável e o valor do negócio somado sozinho
---

O cadastro de Produtos agora também aparece em Configurações (a porta de Produtos no CRM continua). Ao
cadastrar um produto, escolha **Valor fixo** (com preço, como antes) ou **Valor variável** (sem preço de
tabela: o valor é definido pelo atendente dentro de cada negócio, e o atendente de IA não cita preço
desse produto, diz que o valor é combinado no atendimento).

Na ficha do negócio há uma seção **Produtos**: adicione um ou mais produtos do catálogo ativo, cada um
com quantidade e valor unitário (preenchido com o preço do produto fixo e editável; vazio e obrigatório
no produto variável). Quando o negócio tem produtos, o **Valor** do negócio passa a ser a soma deles,
e é esse valor que o funil, as previsões e as perdas usam. Negócio sem produtos continua com o valor
digitado à mão. Adicionar e remover produto aparece na linha do tempo do negócio. A migration 0972 cria
a tabela de itens e os gatilhos da soma; a atualização do banco é automática.
