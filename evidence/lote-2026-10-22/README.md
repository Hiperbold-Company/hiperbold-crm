# Lote de 22/10/2026: prova pela tela

Build de produção local (`next build` + `next start`, porta 3300), banco local com o `baseline.sql` do lote,
conversas de teste na organização local "hiperbold". Navegador automático (Playwright), 26/10/2026.

| Foto | O que prova |
|---|---|
| [01-chat-fila.png](01-chat-fila.png) | Fila do mais recente para o mais antigo; o número 1º, 2º… segue a espera (Rejeane é 1º embaixo); iniciais sem emoji cortado ("R", "MS", "ÉÓ") |
| [03-dialogo-ensinar.png](03-dialogo-ensinar.png) | Conversa encerrada mostra "Usar para ensinar o agente" e o diálogo explica o que acontece |
| [04-ensinando.png](04-ensinando.png) | Depois de confirmar: estado "Ensinando o agente" e aviso de sucesso |
| [05-conhecimento-cartoes.png](05-conhecimento-cartoes.png) | Cartão "Catálogo de Produtos E-commerce" com o texto novo |
| [06-aviso-versao-nova.png](06-aviso-versao-nova.png) | Faixa "Nova versão disponível" quando o servidor responde outro build id |

Também conferido: `/login?next=/app/inbox` com sessão válida vai direto para `/app/inbox`.
Não provado pela tela: o vigia do WhatsApp (item 9) e a falha passageira do login (item 2), cobertos por testes automáticos.
