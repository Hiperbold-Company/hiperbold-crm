---
impacto: capacidade_nova
secao: adicionado
titulo: Automações esperam até um dia e horário, até a data de um campo, e perguntam se está no horário
---

O bloco "Esperar" das automações ganhou duas opções. "Até um dia e horário" espera até hoje, amanhã, daqui a alguns dias ou o próximo dia da semana escolhido, na hora marcada e no fuso da organização; se o horário de hoje já passou, a automação segue na hora. "Até a data de um campo do negócio" espera até a data guardada num campo de data do funil, no dia, alguns dias antes ou depois, na hora marcada; se o campo estiver vazio ou a data já tiver passado, a automação segue pelo caminho "Sem data". As esperas por tempo também podem ser limitadas ao horário comercial. A condição ganhou "Está no horário?", que segue por "Sim" dentro dos dias e horas escolhidos e por "Não" fora deles. Com o worker ligado, uma espera curta termina em poucos segundos em vez de até 1 minuto. Não é preciso mudar nada; o novo ajuste opcional está no `.env.example`.
