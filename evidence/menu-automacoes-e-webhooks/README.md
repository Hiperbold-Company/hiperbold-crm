# Menu: "Webhooks" virou "Automações e Webhooks"

Prova pela tela (build de produção + `next start` na porta 3100, Supabase local, organização
Clínica Exemplo, usuária admin). A rota continua `/app/webhooks`.

- `01-automacoes-e-webhooks.png`: título "Automações e Webhooks", subtítulo novo, abas na ordem
  Automações, Receber dados, Leads recebidos, Registro de atividade, com a tela abrindo em Automações.
- `03-busca-cmd-k-log.png`: busca ⌘K por "log" acha "Automações e Webhooks" (Canais).
- `02-configuracoes.png`: hub de Configurações com a porta de entrada.

Medido por ferramenta (Playwright): título da aba do navegador "Automações e Webhooks · Hiperbold CRM";
abas `["Automações","Receber dados","Leads recebidos","Registro de atividade"]`; aba ativa "Automações";
largura da lista de abas 540 px (o esqueleto de carregamento usa 540 px); `?tab=capturas` abre
"Leads recebidos".
