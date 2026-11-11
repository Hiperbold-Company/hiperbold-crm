---
impacto: nada_mudou
secao: corrigido
titulo: Quem está logado não cai mais no login quando o servidor de login pede calma
---

Quando o servidor de login recebia perguntas demais em pouco tempo, ele respondia "aguarde" e o CRM entendia que a pessoa tinha saído: mandava para a tela de login ou recusava a ação. Agora o CRM pergunta bem menos (reaproveita por alguns segundos a confirmação de quem já entrou, nunca além do prazo do próprio acesso), tenta de novo uma vez e, se o servidor seguir ocupado, mostra a página de "tente de novo em instantes" sem deslogar ninguém. As telas de "Algo deu errado" também passam a deixar uma linha `[client-error]` no log do aplicativo, sem e-mail, telefone ou números longos, para dar para saber o que aconteceu mesmo com o Sentry desligado. Não é preciso mudar nada.
