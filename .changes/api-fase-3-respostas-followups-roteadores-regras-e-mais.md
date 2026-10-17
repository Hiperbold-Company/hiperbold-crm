---
impacto: capacidade_nova
secao: adicionado
titulo: Chave de API administra respostas prontas, follow-ups, roteadores, regras automáticas, distribuição de atendimento e material de conhecimento
---

Uma chave de API com papel de gerente ou administrador (o mesmo da tela) passa a fazer pela API o que
essa pessoa faz na tela: criar, editar e apagar respostas prontas compartilhadas; criar, editar,
duplicar, publicar, desativar e reverter fluxos de follow-up; criar, editar e apagar roteadores de
atendimento e definir as intenções deles; criar, editar e apagar regras automáticas (a regra nasce
pausada, e o segredo de um webhook nunca volta); ler e alterar a distribuição de atendimento; e
cadastrar, editar e arquivar material de conhecimento. Convidar pessoas, mudar papel, revogar e
reativar acesso e criar, editar e arquivar funis também passam a existir como ferramentas do CRM para
o Claude Code, assim como a leitura dos números de WhatsApp conectados e das chaves de IA cadastradas
(sem nenhum segredo). Criações aceitam o cabeçalho `Idempotency-Key`.

Correção de segurança: o recibo de idempotência (a resposta guardada por 24 horas de uma criação) não
era mais do que o servidor deveria ler, mas qualquer membro da organização, o Visualizador inclusive,
conseguia lê-lo diretamente no banco com a própria sessão. Agora só o servidor lê e escreve nele, e o
recibo deixa de guardar o endereço de captação e o segredo digitado de uma entrada automática. A
atualização aplica a mudança sozinha.
