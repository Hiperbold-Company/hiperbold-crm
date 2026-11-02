# Central de ajuda dentro do CRM

Prova pela tela, com `next build` + `next start` (porta 3300), Supabase local e
`HELP_CENTER_URL=https://ajuda.hiperbold.com.br`, logado como admin da
organização de demonstração. Playwright em 1280x900 (e 390x844 no celular).

| Arquivo | O que mostra |
|---|---|
| 01-contatos-barra-e-link.png | Item "Central de ajuda" logo acima de Configurações (abre `/crm/` em nova aba) e a linha "Dúvidas?" abaixo do título de Contatos |
| 02-hub-crm.png | O hub de CRM com o link para "Conhecer o menu" |
| 03-equipe.png | Equipe com o link para "Convidar pessoas" |
| 04 a 07 | Automações e webhooks, aba por aba: Automações, Receber dados (dois links), Leads recebidos, Registro de atividade (sem link) |
| 08-botao-ajuda-com-tab.png | `?tab=capturas`: o botão "Ajuda" do topo abre "Leads recebidos" |
| 09-configuracoes-sem-artigo.png | Tela sem artigo próprio: nenhuma linha "Dúvidas?" (o botão do topo segue na página do produto) |
| 10-etapas-do-funil-campos.png | Etapas do funil, com o link de campos personalizados na seção "Vocabulário e campos" |
| 11-celular-menu.png | Menu do celular com o item "Central de ajuda" |

Medida em 1280x900 (`getBoundingClientRect`): a navegação que rola tem
`scrollHeight` 731 e altura 731, então o item novo no rodapé não empurrou
nenhum grupo para fora da dobra. Todos os links têm `target="_blank"` e
`rel="noopener noreferrer"`.
