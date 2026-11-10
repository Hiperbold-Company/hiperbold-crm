#!/usr/bin/env bash
# Cria os 4 usuários fictícios da org de demonstração (site de vendas) no Supabase LOCAL.
# Senha única gerada uma vez, gravada fora do repositório (~/temp/.../demo-senha), nunca no terminal.
set -euo pipefail
cd "$(dirname "$0")/../.."
getv() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2-; }
URL="$(getv NEXT_PUBLIC_SUPABASE_URL)"
SR="$(getv SUPABASE_SERVICE_ROLE_KEY)"
case "$URL" in http://127.0.0.1:54321|http://localhost:54321) ;; *) echo "RECUSADO: destino nao local ($URL)"; exit 2;; esac
SENHA_F="${DEMO_SENHA_FILE:-$HOME/temp/2026-11-10/d228/demo-senha}"
mkdir -p "$(dirname "$SENHA_F")"
if [ ! -s "$SENHA_F" ]; then umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 512 /dev/urandom) | head -c 20 > "$SENHA_F"; fi
PASS="$(cat "$SENHA_F")"
DB=supabase_db_deskcomm-crm
while IFS='|' read -r email nome; do
  if docker exec "$DB" psql -U postgres -d postgres -tAc "select 1 from auth.users where email='${email}'" | grep -q 1; then
    echo "já existe: $email"; continue
  fi
  curl -fsS -X POST "${URL}/auth/v1/admin/users" -H "apikey: ${SR}" -H "Authorization: Bearer ${SR}" -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${PASS}\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"${nome}\",\"full_name\":\"${nome}\",\"locale\":\"pt-BR\"}}" > /dev/null
  echo "criado: $email"
done <<LIST
juliana.ferraz@exemplo.com.br|Juliana Ferraz
ricardo.almeida@exemplo.com.br|Ricardo Almeida
beatriz.santos@exemplo.com.br|Beatriz Santos
lucas.moreira@exemplo.com.br|Lucas Moreira
LIST
