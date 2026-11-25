---
impacto: nada_mudou
secao: corrigido
titulo: Transcrição de áudio pelo whisper-1 passa a ter custo no Uso de IA
---

A transcrição de áudio feita pela API da OpenAI com o modelo `whisper-1` aparecia no Uso de IA com custo vazio, porque o Whisper cobra por minuto de áudio e nada media a duração. Agora a duração vem na resposta da OpenAI e o custo é gravado pela tarifa de US$ 0,006 por minuto, e o teto de gasto de IA da empresa passa a contar esses áudios. Transcrição por outro endereço ou outro modelo continua sem custo calculado, como antes. Não é preciso mudar nada à mão.
