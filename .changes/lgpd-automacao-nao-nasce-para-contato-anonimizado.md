---
impacto: nada_mudou
secao: corrigido
titulo: Automação não começa para contato que está sendo anonimizado
---

Quando um contato era anonimizado no mesmo instante em que uma automação ia começar para ele, a automação podia nascer logo depois da limpeza, já com os dados do gatilho guardados e rodando para alguém que não deveria mais ser identificado. Agora a automação confere de novo, depois que a anonimização termina, e não começa. As respostas, os retornos de requisição e os dados do gatilho das automações já eram apagados na anonimização; isso continua igual. Não é preciso mudar nada.
