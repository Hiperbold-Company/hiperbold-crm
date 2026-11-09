---
impacto: nada_mudou
secao: alterado
titulo: O worker é avisado pelo banco quando chega trabalho e consulta bem menos a fila
---

O worker passou a ouvir o banco: quando entra um evento ou uma tarefa nova, o próprio banco avisa e o worker acorda na hora. Com esse aviso funcionando, ele espera até 5 minutos entre as consultas de segurança da fila parada, em vez de consultar a cada poucos segundos. Se a conexão de aviso cair, ele volta sozinho ao ritmo de antes até reconectar. Sem o aviso (porta 6543 do pooler ou conexão caída), a fila de respostas do agente segue no ritmo de antes. A agenda deixou de ser enviada ao tempo real, que nenhuma tela usava. Não é preciso mudar nada; a linha `agent-engine pronto` do log do worker mostra se o aviso está ativo. Os novos ajustes opcionais estão no `.env.example`.
