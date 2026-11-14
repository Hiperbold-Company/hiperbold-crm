---
impacto: capacidade_nova
secao: adicionado
titulo: Automações ganham o bloco Sorteio, os dados do anúncio e a ação de atribuir a conversa
---

Três novidades no editor de Automações. O bloco "Sorteio" divide os contatos entre os caminhos A e B ao acaso: você escolhe de 1 a 99% para o A (começa em 50%) e o B recebe o resto; as duas saídas precisam estar ligadas para publicar. Os dados do anúncio de onde o contato veio (código do clique, ID, link, título, texto e tipo de mídia) passam a valer como variáveis nos textos e nos campos, como `{{contact.anuncio.source_id}}`, e aparecem na lista de campos das condições; quem não veio de anúncio fica com o valor em branco. A nova ação "Atribuir a conversa e iniciar o atendimento" passa a conversa do contato para a pessoa escolhida e o atendimento automático para nela, como no botão Transferir da Inbox; se o contato não tem conversa, ou a pessoa não é atendente da conta, a automação sai pelo caminho "Erro". Não é preciso mudar nada.
