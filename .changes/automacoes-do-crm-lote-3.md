---
impacto: capacidade_nova
secao: adicionado
titulo: Automações começam por mensagem, tag, agendamento, datas e silêncio, e uma automação inicia outra
---

As automações ganharam gatilhos novos:

- **Mensagem recebida:** qualquer mensagem, ou só as que contêm, são exatamente ou começam com as palavras-chave escolhidas. A comparação é por palavra inteira, sem acento e sem diferenciar maiúsculas. Dá para escolher o número de WhatsApp e limitar à primeira mensagem da conversa. Não dispara em mensagem de grupo, na resposta a uma automação que está esperando nem, por padrão, quando um atendente cuida da conversa.
- **Tag adicionada** no negócio ou no contato. Tags postas em massa, por ação em lote ou planilha, não disparam.
- **Agendamento:** marcado, confirmado, remarcado, cancelado, compareceu ou faltou.
- **Aniversário do contato**, às 9h no fuso da organização.
- **Data de um campo do negócio**, com antecedência ou atraso em dias e horário, só para negócios abertos por padrão. A automação começa na primeira rodada depois do horário, e as rodadas acontecem de hora em hora.
- **Sem resposta do contato** há um tempo escolhido, contado da última mensagem enviada. Conversas encerradas, com atendente ou de campanha ficam de fora.
- **Caso aberto na Central.**
- **Iniciada por outra automação.**

A nova ação **Iniciar outra automação** passa dados à automação iniciada, que os usa como `{{param.chave}}`, e ela continua no mesmo negócio. A proteção contra ciclo e cadeia longa continua valendo, e o histórico da execução guarda só o nome dos dados, nunca o valor.

Quando uma mensagem inicia uma automação que conversa com o contato, o agente de IA não responde àquela mensagem. Se a automação terminar sem mandar nada, a mensagem volta para o agente.

No bloco Aguardar das automações, "Esperar um tempo" não é mais interrompido quando o contato manda mensagem; para reagir à resposta, use "Esperar o contato responder". A ação Adicionar tag passa a aceitar variáveis. Não há migration nesta versão.
