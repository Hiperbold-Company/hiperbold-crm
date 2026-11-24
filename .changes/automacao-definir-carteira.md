---
impacto: capacidade_nova
secao: adicionado
titulo: Automação define a carteira do cliente e pergunta se ele já tem carteira
---

O bloco "Ações no CRM" das Automações ganha a ação "Definir carteira": o cliente entra na carteira do vendedor escolhido. Se o cliente já estiver na carteira de outro vendedor, a ação mantém o dono atual (o padrão) ou troca para o vendedor escolhido, conforme a opção "Se o cliente já tiver carteira". Como na troca de carteira pela tela, os negócios abertos sem responsável e as conversas abertas do dono anterior (ou sem dono, fora da IA) passam para o novo dono. O vendedor precisa ser atendente, gerente ou administrador ativo; se não for, a ação sai por "Erro". O bloco "Condição" ganha a regra "Carteira do contato", com "Contato tem carteira" e "Contato sem carteira". Não é preciso mudar nada para atualizar.
