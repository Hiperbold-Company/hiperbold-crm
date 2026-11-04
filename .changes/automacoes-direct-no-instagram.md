---
impacto: capacidade_nova
secao: adicionado
titulo: Automações por comentário do Instagram conversam pelo Direct
---

Uma automação que começa por um comentário no Instagram agora conversa com a pessoa pelo Direct:

- **Mensagem, Pergunta e Aguardar pelo Direct.** Depois da resposta privada ("Responda QUERO para receber o link"), a automação espera a pessoa responder e então manda o conteúdo, faz perguntas e guarda as respostas nos campos, tudo pela conversa do Direct. As opções chegam numeradas, e a pessoa responde com o número.
- **Esperar o "quero".** A conversa do Direct só abre quando a pessoa responde. Por isso a automação precisa de um "Aguardar o contato responder" antes da primeira Mensagem ou Pergunta, e a publicação avisa quando falta. A resposta que chega logo depois da resposta privada também vale, mesmo antes de a espera começar. Enquanto a automação espera, o agente de IA não responde nessa conversa.
- **A resposta saiu ou falhou, no histórico.** O histórico da execução mostra quando a resposta privada ou a pública saiu e, quando falhou, o motivo em português (prazo de 7 dias vencido, comentário apagado, conta desconectada).
- **Escolher o post pela lista ou pelo link.** No gatilho, depois de escolher a conta, aparecem os posts recentes com a miniatura, o começo da legenda e a data, e dá para marcar vários. Também dá para colar o link do post. Sem nenhum post marcado, vale qualquer post.
- **Só contas do Instagram** aparecem no gatilho de comentário.

Mudou um comportamento: numa automação que começa por comentário, a Mensagem e a Pergunta saem pelo Direct de quem comentou, não mais pelo WhatsApp. Uma automação assim não pode ter outros gatilhos quando manda mensagens. O texto passa a ter o limite do Instagram (1000 caracteres, contando as opções numeradas). Não há migration nesta versão.
