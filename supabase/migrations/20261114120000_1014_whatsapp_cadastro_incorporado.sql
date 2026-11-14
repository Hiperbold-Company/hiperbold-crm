-- 1014, o número oficial conectado pelo Cadastro Incorporado da Meta (fork Hiperbold).
--
-- ═══ Por quê ═══
--
-- Até aqui o número da Cloud API se conectava colando três valores à mão
-- (id do número, id da WABA e token). O Cadastro Incorporado (Embedded
-- Signup) faz isso pela própria Meta: o cliente autoriza, escolhe o portfólio,
-- a conta do WhatsApp e o número, e o CRM recebe os ids e um código que vira o
-- token de integração do cliente. O login leva o `config_id` de uma
-- configuração do Facebook Login para Empresas do tipo WhatsApp, criada no
-- painel do app da Meta da instalação (o mesmo app do Instagram e do
-- Messenger, `platform_meta_app.app_id`).
-- Doc: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
--
-- O `config_id` não é segredo (vai para o navegador). A chave do app, que
-- troca o código, continua em `app_secret_encrypted`.
--
-- Nenhuma função nova em `public`: o item 9 da doutrina não é acionado.
-- Idempotente: re-aplicável sem efeito novo.

alter table public.platform_meta_app
  add column if not exists whatsapp_config_id text;

comment on column public.platform_meta_app.whatsapp_config_id is
  '1014: id da configuração do Facebook Login para Empresas do tipo WhatsApp Embedded Signup (botão Conectar com a Meta). Não é segredo.';

notify pgrst, 'reload schema';
