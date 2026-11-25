---
impacto: nada_mudou
secao: corrigido
titulo: Conversa que vem de anúncio pela conexão UAZAPI passa a registrar a origem
---

Quando alguém clica num anúncio "Clique para o WhatsApp" e a empresa usa a conexão UAZAPI, o CRM agora grava de qual anúncio a pessoa veio (clique, anúncio, título, texto, link e miniatura), como já fazia na API oficial e no WAHA. As automações passam a receber esses dados em `{{contact.anuncio.*}}`.
