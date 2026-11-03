-- 0988 · Instagram pela "Instagram API com login unificado" (canal meta_social, 0984).
--
-- O Instagram deixa a "Instagram API com login do Instagram" (app próprio do
-- Instagram, instagram.com/oauth, graph.instagram.com) e passa a conectar pelo
-- login do Facebook para Empresas com uma CONFIGURAÇÃO do tipo "token de acesso
-- de usuário do sistema de integração empresarial" (SUAT). O login leva o
-- `config_id` dessa configuração; a troca do código usa o id e a chave do APP
-- DA META (os mesmos do Messenger).
-- Doc: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
--
-- * `platform_meta_app.unified_config_id`: o id da configuração do login
--   unificado. Não é segredo (vai na URL do login). O `.env`
--   (`META_UNIFIED_CONFIG_ID`) segue como piso de rollback, como os outros
--   campos da tabela.
-- * `instagram_app_id` e `instagram_app_secret_encrypted` (0984) ficam OBSOLETAS:
--   o código não as lê nem escreve mais. Não são apagadas porque a coluna já
--   foi distribuída e um rollback da imagem ainda as leria.
--
-- Nenhuma função nova em `public`: o item 9 da doutrina não é acionado.
-- Idempotente: re-aplicável sem efeito novo.

alter table public.platform_meta_app
  add column if not exists unified_config_id text;

comment on column public.platform_meta_app.unified_config_id is
  '0988: id da configuração do login unificado do Instagram (Facebook Login para Empresas, token SUAT). Não é segredo.';

comment on column public.platform_meta_app.instagram_app_id is
  'OBSOLETA desde a 0988: o Instagram conecta pelo login unificado (app da Meta + unified_config_id). Mantida para rollback; o código não lê.';

comment on column public.platform_meta_app.instagram_app_secret_encrypted is
  'OBSOLETA desde a 0988: o Instagram conecta pelo login unificado (app da Meta + unified_config_id). Mantida para rollback; o código não lê.';

notify pgrst, 'reload schema';
