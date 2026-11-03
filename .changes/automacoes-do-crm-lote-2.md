---
impacto: capacidade_nova
secao: adicionado
titulo: Automações conversam com o contato: mensagem com botões ou lista, pergunta e espera
---

O editor de Automações ganhou três blocos:
- **Mensagem:** texto com variáveis e, se quiser, até 3 botões ou uma lista de até 10 opções. Cada opção segue o seu próprio caminho, e há caminhos para "Sem resposta", "Resposta inválida" (com nova tentativa) e "Erro". No WhatsApp oficial o contato vê os botões; nos outros números as opções chegam numeradas (1, 2, 3), e ele pode responder com o número ou com o nome da opção.
- **Pergunta:** grava a resposta num campo do negócio ou do contato e confere se ela é texto, telefone, e-mail, número, CPF ou data. Tem tempo limite e novas tentativas, e a resposta pode ser usada nos blocos seguintes como `{{resposta.<bloco>}}`.
- **Aguardar:** passa a esperar a partir de 1 segundo, ou até o contato responder.

A resposta é processada em até 1 minuto. Enquanto uma automação espera a resposta numa conversa, o agente de IA não responde por cima naquela conversa; se a automação recusar a resposta e não tiver caminho para ela, a mensagem volta para o agente.

Cada contato recebe no máximo 30 mensagens automáticas por hora. Contato bloqueado, contato sem conversa de WhatsApp e janela de 24 horas fechada no número oficial levam o fluxo ao caminho "Erro", com o motivo escrito em Execuções. Não há migration nesta versão.
