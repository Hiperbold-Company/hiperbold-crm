#!/usr/bin/env bash
# Consulta SOMENTE LEITURA no banco de PRODUÇÃO (Supabase Cloud), para conferir uma publicação
# sem risco de escrita: a sessão abre com `default_transaction_read_only=on`.
#
# Uso: bash hiperbold/scripts/prod-leitura.sh "select count(*) from public.organizations"
#      bash hiperbold/scripts/prod-leitura.sh -f caminho/da/consulta.sql
# Consulta com `$$` vai por arquivo (-f): na linha de comando o shell expande o `$$`.
set -euo pipefail
cd "$(dirname "$0")/../.."
F=.env.production
[ -r "$F" ] || { echo "falta $F"; exit 1; }
[ "$#" -ge 1 ] || { echo "uso: prod-leitura.sh \"<sql>\" | -f <arquivo.sql>"; exit 1; }

getv() { { grep -E "^$1=" "$F" || true; } | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//; s/^\"//; s/\"$//" | tr -d '\r'; }
URL="$(getv SUPABASE_DB_URL)"
[ -n "$URL" ] || { echo "sem SUPABASE_DB_URL em $F"; exit 1; }

if [ "$1" = "-f" ]; then
  ARQ="$(realpath "$2")"
  docker run --rm -e PGOPTIONS="-c default_transaction_read_only=on" -v "$ARQ:/consulta.sql:ro" \
    postgres:17-alpine psql "$URL" -tA -v ON_ERROR_STOP=1 -f /consulta.sql
else
  docker run --rm -e PGOPTIONS="-c default_transaction_read_only=on" \
    postgres:17-alpine psql "$URL" -tA -v ON_ERROR_STOP=1 -c "$1"
fi
