#!/usr/bin/env bash
# Responde se um PR vai pela ROTA URGENTE: `sim` ou `nao` na saída padrão, e o
# motivo na saída de erro. Exclusivo do fork Hiperbold-Company/hiperbold-crm.
#
# Rota urgente = o PR tem o rótulo `urgente` E não mexe em nenhum caminho que
# exige a medida completa (lista em CAMINHO_COMPLETO, abaixo). Nela, o ci.yml
# pula a matriz `invariants-majors` e o e2e.yml pula as partes; o verify e o
# build seguem. Arquivo renomeado conta pelos dois nomes (`previous_filename`).
#
# No ci.yml e no e2e.yml este script é lido da BASE do PR, nunca do merge ref:
# senão o próprio PR poderia reescrevê-lo para responder `sim`. Pelo mesmo
# motivo, PR que mexe nele ou nos dois workflows que o chamam vai pelo caminho
# completo.
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

# Caminhos que nunca vão pela rota urgente, e por quê:
#   supabase/                 migration e baseline: só a matriz do test:db aplica o
#                             baseline.sql que a VPS aplica;
#   update.sh, docker-compose*.yml, hostgator-setup-kit/, scripts/test-db*.sh:
#                             o kit e a atualização de quem já instalou, que o
#                             test:db (update com dados) exercita;
#   este script, ci.yml e e2e.yml: quem decide o pulo não pode ser mudado pelo
#                             mesmo PR que pula.
CAMINHO_COMPLETO='^supabase/|(^|/)update\.sh$|(^|/)docker-compose[^/]*\.ya?ml$|^hostgator-setup-kit/|^scripts/test-db[^/]*\.sh$|^scripts/pr-rota-urgente\.sh$|^\.github/workflows/(ci|e2e)\.yml$'

if ! arquivos=$(gh api --paginate "repos/${repo}/pulls/${pr}/files?per_page=100" --jq '.[] | .filename, (.previous_filename // empty)' 2>/dev/null); then
  responde nao "não consegui listar os arquivos do PR #${pr}"
fi
n=$(printf '%s\n' "$arquivos" | grep -c . || true)
if [ "$n" -eq 0 ]; then
  responde nao "a lista de arquivos do PR #${pr} veio vazia"
fi
if [ "$n" -ge 3000 ]; then
  responde nao "lista de arquivos cortada em ${n}"
fi
if alcancado=$(printf '%s\n' "$arquivos" | grep -E "$CAMINHO_COMPLETO" | head -3 | tr '\n' ' ') && [ -n "$alcancado" ]; then
  responde nao "PR #${pr} tem rótulo urgente mas mexe em ${alcancado% }: exige o caminho completo"
fi

responde sim "PR #${pr} com rótulo urgente, ${n} nome(s) de arquivo, nenhum que exija o caminho completo"
