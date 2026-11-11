---
impacto: capacidade_nova
secao: adicionado
titulo: Banco de dados externo na rede interna, só com a permissão da instalação
---

O banco de dados externo continua recusando, por padrão, endereços da rede interna do servidor (como 10.x, 172.16.x a 172.31.x e 192.168.x). Quem instala o sistema no próprio servidor, com o ERP na mesma rede, agora pode liberar essas faixas com a variável `EXTERNAL_DB_PERMITIR_REDE_PRIVADA=true` no `.env` da instalação. Ligue só se todas as empresas da instalação forem de confiança. Mesmo ligada, o endereço do próprio servidor (localhost) e o de metadados da nuvem (169.254.x) seguem bloqueados. Nada muda para quem não define a variável.

A conexão com bancos MySQL agora abre no endereço que foi conferido, como já acontecia com o PostgreSQL. E qualquer endereço recusado mostra a mesma mensagem, seja qual for o motivo.
