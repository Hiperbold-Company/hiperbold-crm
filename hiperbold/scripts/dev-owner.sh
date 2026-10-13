#!/usr/bin/env bash
# Cria o acesso de administrador no CRM LOCAL (Supabase local): usuário no Auth,
# organização Hiperbold e super-admin. A senha vai para o arquivo
# hiperbold-crm-data.md, sempre fora do repositório e nunca para o terminal:
# F:\github-projects no WSL, ~/github-projects no Mac, a pasta do usuário no
# Codespaces, ou o caminho em HIPERBOLD_CRM_DADOS.
set -euo pipefail
cd "$(dirname "$0")/../.."
EMAIL="${OWNER_EMAIL:-oliveira@hiperbold.com.br}"
if [ -n "${HIPERBOLD_CRM_DADOS:-}" ]; then
  DADOS="$HIPERBOLD_CRM_DADOS"
elif [ -d /mnt/f/github-projects ]; then
  DADOS=/mnt/f/github-projects/hiperbold-crm-data.md
elif [ -d "$HOME/github-projects" ]; then
  DADOS="$HOME/github-projects/hiperbold-crm-data.md"
else
  DADOS="$HOME/hiperbold-crm-data.md"
fi

getv() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2-; }
URL="$(getv NEXT_PUBLIC_SUPABASE_URL)"
SR="$(getv SUPABASE_SERVICE_ROLE_KEY)"
DB=$(docker ps --format '{{.Names}}' | grep -E '^supabase_db_' | head -1)
psqlc() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

if psqlc -tAc "select 1 from auth.users where email='${EMAIL}'" | grep -q 1; then
  echo "usuário local já existe, não gero senha nova"
else
  PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 512 /dev/urandom) | head -c 20)"
  curl -fsS -X POST "${URL}/auth/v1/admin/users" \
    -H "apikey: ${SR}" -H "Authorization: Bearer ${SR}" -H "Content-Type: application/json" \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASS}\",\"email_confirm\":true,\"user_metadata\":{\"locale\":\"pt-BR\"}}" \
    > /dev/null
  umask 077
  {
    [ -s "$DADOS" ] || printf '# Hiperbold CRM (DeskcommCRM) · acessos\n\nNão colar em chat nem em commit.\n'
    printf '\n## Local (WSL, desenvolvimento)\n\nEndereço: http://localhost:3300\nE-mail: %s\nSenha: %s\nCriado em %s. Some se o banco local for recriado (supabase-local.sh).\n' \
      "$EMAIL" "$PASS" "$(date -Iseconds)"
  } >> "$DADOS"
  echo "senha local gravada em $DADOS"
fi

psqlc <<SQL
do \$\$
declare v_org uuid; v_uid uuid;
begin
  select id into v_uid from auth.users where email = '${EMAIL}';
  if v_uid is null then
    raise exception 'usuário % não encontrado no auth.users', '${EMAIL}';
  end if;
  select id into v_org from public.organizations where slug = 'hiperbold';
  if v_org is null then
    insert into public.organizations (slug, display_name, legal_name, locale, created_by)
    values ('hiperbold', 'Hiperbold', 'Hiperbold', 'pt-BR', v_uid)
    returning id into v_org;
  end if;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  values (v_uid, v_org, 'admin', now())
  on conflict (user_id, organization_id) do update set role = 'admin', revoked_at = null;
  if not exists (select 1 from public.platform_admins where user_id = v_uid and revoked_at is null) then
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
    values (v_uid, v_uid, 'full', false, 'Bootstrap local Hiperbold');
  end if;
end \$\$;
SQL
echo "acesso local pronto: organização Hiperbold + super-admin"
