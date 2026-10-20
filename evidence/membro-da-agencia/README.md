# Prova pela tela: membro da agência (migration 0974)

Ambiente: `next build` + `next start` (porta 3974), Supabase local (`127.0.0.1:54321` e Postgres `54322`) com a
migration 0974 aplicada, dados fictícios (domínio `prova0974.test`, organização "Clínica Prova 0974"), navegador
dirigido por Playwright. Dados e `.env.local` copiado foram apagados depois da prova.

Cenário: a agência (admin da plataforma, escopo full) cria a organização pelo painel com o e-mail da dona como
responsável, e a dona aceita o convite de administrador (a entrega). Antes da 0974 esse aceite apagava o vínculo
da agência. Agora ele continua.

| Print | O que prova |
|---|---|
| `01-painel-do-tenant-antes.png` | Página do tenant no painel de plataforma, seção "Membros da agência": o criador aparece como membro da agência mesmo depois de a dona ter aceitado o convite. |
| `02-painel-do-tenant-com-novo-membro.png` | "Adicionar membro da agência" com o e-mail de um usuário existente: aviso "Membro da agência adicionado." e a pessoa na lista, com "Remover". |
| `03-painel-usuario-inexistente.png` | E-mail sem conta: frase fixa "Não existe usuário com esse e-mail...", sem texto cru do banco. |
| `04-equipe-do-cliente-com-selo-agencia.png` | Tela Equipe vista pela dona: os dois membros da agência com o selo "Agência" e o texto "Acesso da agência que opera o seu CRM. Não ocupa vaga do plano.", sem seletor de papel, sem botão de interface e sem menu de ações; o atendente comum segue com tudo. |

Medidas pela tela (Playwright, tela Equipe do cliente, linha da agência): selo visível, texto visível, 0 seletores
de papel, 0 menus de ações, 0 botões de interface; 1 menu de ações na tabela inteira (o do atendente comum).

O servidor também recusa, pela sessão da dona: `PATCH /api/v1/team/<agência>` (trocar papel) responde 403 e
`POST /api/v1/team/<agência>/revoke` responde 403.
