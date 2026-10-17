---
impacto: capacidade_nova
secao: adicionado
titulo: Chave de API administra agentes de IA, campos personalizados do funil e o segredo das entradas automáticas
---

Uma chave de API com papel de administrador (ou de gerente, nas entradas automáticas) passa a fazer
pela API o que o administrador faz na tela: listar, criar, salvar versão nova, publicar e pausar
agentes de IA; acrescentar, alterar e remover campos personalizados de um funil, um a um, sem reenviar
a lista inteira; e gerar ou girar o segredo de assinatura de uma entrada automática de contatos. O
segredo aparece uma única vez, na resposta que o gerou. As mesmas ações estão disponíveis como
ferramentas do CRM para o Claude Code. Criações aceitam o cabeçalho `Idempotency-Key`.
