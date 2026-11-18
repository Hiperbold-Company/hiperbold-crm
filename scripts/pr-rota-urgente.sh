#!/usr/bin/env bash
# Responde se um PR vai pela ROTA URGENTE: `sim` ou `nao` na saída padrão, e o
# motivo na saída de erro. Exclusivo do fork Hiperbold-Company/hiperbold-crm.
#
# Rota urgente = o PR tem o rótulo `urgente` E não mexe em nada sob `supabase/`
# (migration e baseline exigem o caminho completo: a matriz do test:db é o único
# gate que aplica o baseline.sql que a VPS aplica). Nela, o ci.yml pula a matriz
# `invariants-majors` e o e2e.yml pula as partes; o verify e o build seguem.
#
# O rótulo é lido pela API, não pelo payload do evento: o "re-run" de um job
# reusa o payload antigo, e o rótulo posto depois não apareceria nele.
#
# Tudo do lado seguro: qualquer falha de consulta, lista cortada (a API para em
# 3000 arquivos) ou lista vazia responde `nao` — não saber nunca vira "pode pular".
#
# Uso: GITHUB_REPOSITORY=dono/repo bash scripts/pr-rota-urgente.sh <número do PR>
# Precisa de `gh` autenticado (GH_TOKEN). Sai 0 sempre que responde; 2 em uso errado.
set -uo pipefail

pr="${1:-}"
repo="${GITHUB_REPOSITORY:-}"
if [ -z "$repo" ] || ! printf '%s' "$pr" | grep -Eq '^[0-9]+$'; then
  echo "uso: GITHUB_REPOSITORY=dono/repo $0 <número do PR>" >&2
  exit 2
fi

responde() {
  echo "rota urgente: $1 ($2)" >&2
  echo "$1"
  exit 0
}

if ! rotulos=$(gh api "repos/${repo}/pulls/${pr}" --jq '.labels[].name' 2>/dev/null); then
  responde nao "não consegui ler os rótulos do PR #${pr}"
fi
if ! printf '%s\n' "$rotulos" | grep -qx 'urgente'; then
  responde nao "PR #${pr} sem o rótulo urgente"
fi

if ! arquivos=$(gh api --paginate "repos/${repo}/pulls/${pr}/files?per_page=100" --jq '.[].filename' 2>/dev/null); then
  responde nao "não consegui listar os arquivos do PR #${pr}"
fi
n=$(printf '%s\n' "$arquivos" | grep -c . || true)
if [ "$n" -eq 0 ]; then
  responde nao "a lista de arquivos do PR #${pr} veio vazia"
fi
if [ "$n" -ge 3000 ]; then
  responde nao "lista de arquivos cortada em ${n}"
fi
if printf '%s\n' "$arquivos" | grep -q '^supabase/'; then
  responde nao "PR #${pr} tem rótulo urgente mas mexe em supabase/: exige o caminho completo"
fi

responde sim "PR #${pr} com rótulo urgente, ${n} arquivo(s), nenhum em supabase/"
