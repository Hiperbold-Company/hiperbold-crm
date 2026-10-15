#!/usr/bin/env bash
# Grava no Supabase de PRODUÇÃO os modelos dos e-mails de acesso (confirmar
# conta e redefinir senha) que o próprio CRM publica em /email-templates/<modelo>,
# já com a marca da instalação (logo, nome, cor). O Supabase da nuvem não busca
# modelo por URL: o conteúdo precisa ir pela Management API.
#
# Rodar DEPOIS de o deploy com a mudança no modelo estar no ar.
# Lê SUPABASE_ACCESS_TOKEN do .env global; nenhum valor é impresso.
#
# Uso: bash hiperbold/scripts/prod-emails-de-acesso.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
G="$HOME/.claude/.env"
T="$({ grep -E '^SUPABASE_ACCESS_TOKEN=' "$G" || true; } | head -1 | cut -d= -f2- | tr -d '"\r')"
[ -n "$T" ] || { echo "SUPABASE_ACCESS_TOKEN ausente no .env global"; exit 1; }
REF="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.production | cut -d= -f2- | sed -E "s#^'?https://([^.]+)\..*#\1#")"
APP=https://crm.hiperbold.com.br

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for m in confirmation recovery; do
  curl -sf -m 30 "$APP/email-templates/$m" -o "$TMP/$m.html"
  grep -q '{{ .TokenHash }}' "$TMP/$m.html" || { echo "$m: modelo sem token_hash, nada gravado"; exit 1; }
  grep -q '<img' "$TMP/$m.html" || { echo "$m: modelo sem logo, nada gravado"; exit 1; }
done

python3 - "$TMP" > "$TMP/corpo.json" <<'PY'
import json, sys
d = sys.argv[1]
print(json.dumps({
    "mailer_templates_confirmation_content": open(f"{d}/confirmation.html").read(),
    "mailer_templates_recovery_content": open(f"{d}/recovery.html").read(),
}))
PY

code="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $T" -H "content-type: application/json" \
  --data @"$TMP/corpo.json" "https://api.supabase.com/v1/projects/$REF/config/auth")"
echo "modelos de e-mail de acesso: http $code"
[ "$code" = 200 ] || exit 1

curl -s -m 30 -H "Authorization: Bearer $T" "https://api.supabase.com/v1/projects/$REF/config/auth" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); c=d.get("mailer_templates_confirmation_content") or ""; print("confirmação com logo:", "<img" in c, "| com link por extenso:", "cole no seu navegador" in c)'
