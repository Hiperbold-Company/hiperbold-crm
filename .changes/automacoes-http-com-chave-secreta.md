---
impacto: capacidade_nova
secao: adicionado
titulo: Automações chamam outros sistemas, com chave secreta guardada
---

As automações ganharam o bloco "Requisição HTTP", no grupo Integrações da paleta. Ele chama o endereço de outro sistema (por exemplo, uma plataforma de anúncios ou uma planilha), pode levar dados do contato no pedido e guarda campos da resposta no negócio. O bloco tem duas saídas: "Deu certo" e "Falhou". Só endereços https de sites públicos são aceitos; endereços internos, redirecionamentos e respostas maiores que 2 MB são recusados, e a automação segue pela saída "Falhou" com a explicação em português.

Para chamadas que pedem senha ou token, há uma tela nova, Automações › Chaves secretas. A chave é digitada uma vez, fica guardada cifrada e depois aparece só como ••••final: nem a tela, nem o histórico da automação mostram o valor. No bloco, a chave é escolhida pelo nome, dentro de um cabeçalho (como Authorization). Gerentes e administradores criam, trocam e apagam as chaves.
