---
impacto: capacidade_nova
secao: adicionado
titulo: WhatsApp por QR Code via WAHA volta a ser opção em Conexões
---

Quando a instalação tem o WAHA configurado (`WAHA_API_BASE_URL` e `WAHA_API_KEY`), o "Criar" da tela de Conexões volta a oferecer "WhatsApp por QR Code (WAHA)", ao lado do WhatsApp por QR Code e do WhatsApp oficial, para todas as empresas. Quem administra a conta cria a conexão, lê o QR Code (que se renova sozinho) ou usa o código de pareamento, e acompanha até "Conectado". O cartão da conexão diz "WhatsApp por QR Code (WAHA)" e, no Gerenciar, reconecta e remove pelo próprio WAHA. O limite de conexões do plano vale como nos outros tipos. Sem o WAHA configurado nada muda: a opção não aparece, e a instalação também passa a subir sem as variáveis `WAHA_*`, que deixaram de ser obrigatórias. Para as mensagens recebidas entrarem no CRM, o WAHA precisa entregar os eventos ao app pela rede interna, com `WAHA_GLOBAL_WEBHOOK_ENABLED=true` no `.env` (a entrada global do WAHA segue fechada por padrão).
