---
impacto: capacidade_nova
secao: adicionado
titulo: Transcrição de áudio com interruptor por empresa e desconto de tokens do plano
---

Em Configurações › Atendimento há uma nova opção, "Transcrever áudios", que gerente ou administrador liga e desliga. Ela vem ligada: empresa que não mexer continua transcrevendo como antes. Desligada, o áudio recebido fica na conversa sem texto, o agente de IA não recebe transcrição e nada é gasto com ela. A opção vale também para a fala dos vídeos: desligada, os vídeos continuam sendo lidos pelas imagens, mas a fala não é transcrita.

A transcrição feita com a chave da plataforma passa a descontar tokens do plano: 6.000 tokens por minuto de áudio, proporcional aos segundos e arredondado para cima, e cada áudio conta no máximo 10 minutos. Aparece no extrato do mês em Meu plano, no dia da transcrição e na linha sem agente. Transcrição que falhou, que voltou vazia ou cuja duração o serviço não informou não desconta. Com a chave da própria empresa em Provedores de IA, nada sai do plano.

A transcrição de áudio pela API da OpenAI com o modelo `whisper-1` também passa a ter custo no Uso de IA (US$ 0,006 por minuto), e o teto de gasto de IA da empresa passa a contar esses áudios. Não é preciso mudar nada à mão.
