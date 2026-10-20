---
impacto: nada_mudou
secao: corrigido
titulo: Empresa, cargo e UTMs enviados pela captação agora aparecem na ficha do negócio
---

Quando um formulário, o n8n ou outra ferramenta enviava um lead com campos como "Empresa" e "Cargo" ou
com as UTMs (`utm_source`, `utm_campaign`...), o dado chegava, mas ficava guardado com o nome que a
ferramenta usou, e a ficha do negócio não o mostrava nos blocos "Dados do lead" e "Rastreamento" — ela lê
pelo campo que o funil declara.

Agora a captação encaixa cada informação no campo do funil correspondente, comparando pela chave ou pelo
nome do campo sem diferenciar maiúsculas, acentos, espaços, hífen ou underscore ("Cargo" encaixa em
"Cargo / Posição"). As UTMs e os identificadores de clique também passam a preencher o campo do funil,
quando ele existe, e continuam registrados na origem do lead. O que não tem campo correspondente segue
guardado como antes, sem perder nada, e um valor que já está no campo nunca é sobrescrito. Nenhuma ação é
necessária.
