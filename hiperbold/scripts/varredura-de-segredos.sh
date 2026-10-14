#!/usr/bin/env bash
# Varredura de segredos no que vai subir. Compara a branch atual com a base e procura
# arquivo sensível (.env, chave, dump) e padrão de credencial nas linhas acrescentadas.
# Rodar antes de todo push que vai para a `main`. Sai com 1 se achar alguma coisa.
#
# Uso: bash hiperbold/scripts/varredura-de-segredos.sh [base]   (padrão: origin/main)
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${1:-origin/main}"

ARQUIVOS="$(git diff "$BASE"...HEAD --name-only)"
echo "arquivos alterados: $(printf '%s\n' "$ARQUIVOS" | grep -c . || true)"
SENSIVEIS="$(printf '%s\n' "$ARQUIVOS" | grep -i -E '\.env($|\.)|\.pem$|\.key$|\.dump$|id_rsa' | grep -v -E '\.env\.example$|\.env\..*\.example$' || true)"

# Asaas, OpenAI, Stripe, JWT, Turnstile, chave privada, Meta, GitHub, Slack e AWS.
PADRAO='\$aact_(prod|hmlg)_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|sk_live[_]|eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|0x4AAAA[A-Za-z0-9_-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|EAA[A-Za-z0-9]{40,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-|AKIA[0-9A-Z]{16}'
ACHADOS="$(git diff "$BASE"...HEAD -U0 | grep -E '^\+' | grep -v '^+++' | grep -n -E "$PADRAO" | cut -c1-60 || true)"

if [ -n "$SENSIVEIS" ]; then echo "ARQUIVO SENSÍVEL:"; printf '%s\n' "$SENSIVEIS"; fi
if [ -n "$ACHADOS" ]; then echo "PADRÃO DE CREDENCIAL (início da linha):"; printf '%s\n' "$ACHADOS"; fi
if [ -n "$SENSIVEIS$ACHADOS" ]; then exit 1; fi
echo "sem segredo no que vai subir"
