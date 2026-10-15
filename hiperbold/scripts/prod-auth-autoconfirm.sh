#!/usr/bin/env bash
# Liga a confirmação automática de cadastro (`mailer_autoconfirm = true`) no Supabase de PRODUÇÃO pela
# Management API. Com ela ligada o Supabase deixa de exigir o clique no e-mail para a pessoa entrar: o
# cadastro devolve a sessão, a pessoa cai direto no pagamento, e a confirmação do e-mail passa a ser a do
# próprio CRM (e-mail "Confirme seu e-mail" + faixa no topo; lib/auth/verificacao-email.ts).
#
# ⚠️ É MUDANÇA DE CONFIGURAÇÃO DE PRODUÇÃO. Roda por último na janela de publicação
# (hiperbold/README.md), DEPOIS de o código novo estar no ar: ligar antes leva quem se cadastra ao wizard
# antigo, sem o pagamento e sem o e-mail de confirmação do CRM. Só com autorização explícita do dono.
#
# Lê SUPABASE_ACCESS_TOKEN do .env global; nenhum valor sensível é impresso (só o código HTTP e a chave).
#
# Uso: bash hiperbold/scripts/prod-auth-autoconfirm.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
G="$HOME/.claude/.env"
T="$({ grep -E '^SUPABASE_ACCESS_TOKEN=' "$G" || true; } | head -1 | cut -d= -f2- | tr -d '"\r')"
[ -n "$T" ] || { echo "SUPABASE_ACCESS_TOKEN ausente no .env global"; exit 1; }
REF="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.production | cut -d= -f2- | sed -E "s#^'?https://([^.]+)\..*#\1#")"
[ -n "$REF" ] || { echo "NEXT_PUBLIC_SUPABASE_URL ausente no .env.production"; exit 1; }

code="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $T" -H "content-type: application/json" \
  --data '{"mailer_autoconfirm": true}' "https://api.supabase.com/v1/projects/$REF/config/auth")"
echo "mailer_autoconfirm: http $code"
[ "$code" = 200 ] || exit 1

curl -s -m 30 -H "Authorization: Bearer $T" "https://api.supabase.com/v1/projects/$REF/config/auth" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("mailer_autoconfirm agora:", d.get("mailer_autoconfirm"))'
