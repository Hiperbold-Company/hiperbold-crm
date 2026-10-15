# Entrada do cliente: escolher plano, criar conta, pagar, entrar (prova pela tela, 15/10/2026)

Prova feita com Playwright, no ambiente local: Supabase local (confirmação de e-mail ligada), compra pelo cliente ligada,
Asaas SANDBOX, `billing_settings.modo = bloquear`, e-mails lidos no Mailpit. O pagamento foi marcado como pago no
sandbox do Asaas (`receiveInCash`) e o webhook foi entregue localmente na rota `/api/v1/webhooks/asaas`, seguido do cron
`processar-eventos-asaas`. Duas contas de teste, A (imagens 04 a 19, exceto as de 01 a 03) e B (imagens 01 a 03 e 20).

| Imagem | O que mostra |
|---|---|
| `01-signup-plano-max.png` | `/signup?plano=max`, depois de clicar em "Assinar o Max" em `/precos`. |
| `02-signup-preenchido.png` | Cadastro preenchido: empresa, e-mail, senha, confirmação e aceite dos Termos. |
| `03-signup-enviado.png` | Depois de enviar: "Confirme seu e-mail" (a confirmação do Supabase local está ligada). |
| `04-pagamento-apos-confirmar.png` | Link do e-mail clicado: cai em `/onboarding/plano`, com logo, sem indicador de passos do wizard, Max marcado. |
| `07-forma-de-pagamento-semestral.png` | Resumo do ciclo semestral, antes de trocar a forma de pagamento (cartão é o padrão). |
| `08-resumo-pix.png` | Resumo com Pix escolhido. |
| `09-pix-aguardando-pagamento.png` | Pix gerado no sandbox: QR, copia e cola e "aguardando a confirmação do pagamento". |
| `10-inicio-apos-pagar.png` | Pago: `/app/inicio` com Plano ativo feito e os outros obrigatórios pendentes. |
| `11-email-confirme-seu-email.png` | E-mail "Confirme seu e-mail" do CRM (Mailpit). |
| `12-inicio-com-banner-de-email.png` | Barra amarela no topo, "Reenviar", Início com "Confirmar seu e-mail" pendente. |
| `13-sidebar.png` | Menu lateral: Início, Inbox, Radar, Funis, Contatos, Agentes, Desempenho, Atividades e Configurações. |
| `14-configuracoes.png` | `/app/settings` com as seções Atendimento, IA e Canais. |
| `15-email-confirmado.png` | Tela "E-mail confirmado" depois de clicar no link. |
| `16-inicio-email-confirmado.png` | Barra sumiu; "Confirmar seu e-mail" feito. |
| `17-configuracoes-empresa-perfil.png` | Configurações › Empresa › "O que sua empresa faz", preenchido. |
| `18-perfil-salvo.png` | Depois de "Salvar perfil". |
| `19-inicio-perfil-feito.png` | Início com Perfil da empresa feito ("3 de 4 obrigatórios"). |
| `20-pix-pago-entrou-sozinho-no-inicio.png` | Conta B: com o painel do Pix aberto, o pagamento foi confirmado e a tela foi para `/app/inicio` sozinha, em 5 s, sem recarregar. |
