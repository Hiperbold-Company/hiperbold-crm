---
impacto: exige_acao
secao: alterado
titulo: Nas conversas, a IA só consulta o banco externo no que o administrador liberou, e só os dados de quem está conversando
---

Antes, a IA que atende no WhatsApp podia ler qualquer tabela do banco externo conectado, e um cliente podia pedir dados de outra pessoa. Agora, em Integração de dados › "O que o assistente pode ver", cada tabela liberada diz de quem é o dado: "serve para qualquer cliente" (produtos, preços, horários) ou "é de cada cliente" (pedidos, cadastro, cobranças), escolhendo a coluna que guarda o cliente e o que ela guarda: telefone, e-mail ou CPF/CNPJ. Numa tabela "de cada cliente", a IA só recebe as linhas do contato da conversa, pelo dado do cadastro dele no CRM, e não pelo que o cliente digita. Se o contato não tiver esse dado, a IA não consulta e diz que a equipe confirma. As integrações por API e pelo servidor MCP não mudam.

## Requer atenção

Depois de atualizar, se uma conexão de banco externo está em "Tudo que o usuário do banco enxerga", a IA deixa de consultar esse banco nas conversas. Para voltar, um administrador da organização abre Integração de dados › "O que o assistente pode ver", escolhe "Só o que eu marcar", marca as tabelas e diz, em cada uma, de quem é o dado. Não é preciso mexer no servidor nem no `.env`.
