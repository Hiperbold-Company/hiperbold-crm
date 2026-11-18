#!/usr/bin/env bash
# O commit liberado AINDA é o topo da main? Último passo antes do deploy-easypanel.yml
# pedir ao EasyPanel que baixe as imagens.
#
# O EasyPanel não recebe sha: ele puxa a tag móvel do GHCR, que aponta para o
# publish mais recente. Se outro merge entrou depois deste commit, liberar o
# deploy dele publicaria o código MAIS NOVO com a prova do mais velho. Então só
# o topo deploya; o commit superado recusa aqui, e o deploy do commit mais novo
# (que passa pelo próprio portão) é quem leva a produção adiante.
#
# Uso: GITHUB_REPOSITORY=dono/repo bash scripts/ainda-e-o-topo-da-main.sh <sha>
# Sai 0 se é o topo; 1 se não é ou se não deu para ler (nunca libera no escuro);
# 2 em uso errado.
set -uo pipefail

sha="${1:-}"
repo="${GITHUB_REPOSITORY:-}"
if [ -z "$repo" ] || ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "uso: GITHUB_REPOSITORY=dono/repo $0 <sha40>" >&2
  exit 2
fi

if ! topo=$(gh api "repos/${repo}/commits/main" --jq '.sha' 2>/dev/null) || ! printf '%s' "$topo" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "::error::não consegui ler o topo da main: sem saber, não peço deploy de ${sha}"
  exit 1
fi
if [ "$topo" != "$sha" ]; then
  echo "::error::${sha} já não é o topo da main (topo: ${topo}). Não peço deploy: a imagem que o EasyPanel puxaria é a do commit mais novo, e o deploy DELE cuida da produção."
  exit 1
fi
echo "ok: ${sha} é o topo da main"
