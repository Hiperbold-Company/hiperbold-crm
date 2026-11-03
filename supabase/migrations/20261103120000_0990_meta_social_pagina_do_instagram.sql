-- 0990 · Instagram conectado pela Página do Facebook (canal meta_social, 0984/0988).
--
-- Pelo login unificado, quando `/me/assigned_instagram_accounts` e o
-- `granular_scopes` do `debug_token` voltam vazios, a conta do Instagram é
-- achada pela Página que a possui (`/me/accounts?fields=instagram_business_account`),
-- e a Instagram Messaging API exige o token DA PÁGINA: o envio vai a
-- `/<PAGE_ID>/messages` e o webhook é assinado em `/<PAGE_ID>/subscribed_apps`.
-- Doc: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
--
-- * `channel_sessions.meta_social_page_id`: id da Página dona da conta do
--   Instagram. Null = a conta veio pelo token do usuário do sistema (SUAT) e o
--   envio segue em `/<IG_ID>/messages`. No Messenger fica sempre null (a conta
--   já É a Página).
--
-- Nenhuma função nova em `public`: o item 9 da doutrina não é acionado.
-- Idempotente: re-aplicável sem efeito novo.

alter table public.channel_sessions
  add column if not exists meta_social_page_id text;

comment on column public.channel_sessions.meta_social_page_id is
  'Instagram conectado pela Página (Facebook Login): id da Página dona da conta; o envio vai a /<page>/messages com o token da Página. Null = token do usuário do sistema (login unificado)';

notify pgrst, 'reload schema';
