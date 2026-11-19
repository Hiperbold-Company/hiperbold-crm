#!/usr/bin/env bash
# shellcheck disable=SC2016  # $HOME entre aspas simples expande NO SERVIDOR, de propósito
# verificar <branch> [--script-local]
#
# Roda no Mac. Pelo SSH, põe o clone da verificação (~/verificacao/hiperbold-crm
# no servidor hiperbold-homolog) na branch pedida, igual ao GitHub (fetch +
# checkout + reset --hard: esse clone é SÓ da verificação), executa a parte
# remota, hiperbold/scripts/verificar-remoto.sh, daquela mesma branch, e grava
# o resultado como status `verificar/wsl` no commit do GitHub.
#
#   --script-local  executa a verificar-remoto.sh DESTE checkout em vez da que
#                   está na branch (para testar o próprio script antes do push,
#                   ou verificar uma branch que ainda não tem o script)
#
# Ver hiperbold/verificacao.md.
set -euo pipefail

HOST="${VERIFICAR_HOST:-filipe@hiperbold-homolog}"
REPO_URL="https://github.com/Hiperbold-Company/hiperbold-crm.git"
AQUI="$(cd "$(dirname "$0")" && pwd)"

uso() { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; }

BRANCH=""
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --script-local) LOCAL=1 ;;
    -h|--help) uso; exit 0 ;;
    -*) echo "opção desconhecida: $arg" >&2; uso >&2; exit 2 ;;
    *)
      [ -z "$BRANCH" ] || { echo "só uma branch por vez" >&2; exit 2; }
      BRANCH="$arg" ;;
  esac
done
[ -n "$BRANCH" ] || { uso >&2; exit 2; }
# O nome vai para um comando remoto: só o que nome de branch costuma ter.
if ! [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$BRANCH" == -* || "$BRANCH" == *..* ]]; then
  echo "nome de branch recusado: $BRANCH" >&2
  exit 2
fi

# A rodada passa de meia hora: o keepalive evita que a sessão ociosa caia.
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 "$HOST")

echo "== clone da verificação -> origin/$BRANCH"
"${SSH[@]}" bash -s -- "$BRANCH" "$REPO_URL" <<'REMOTO'
set -euo pipefail
mkdir -p "$HOME/verificacao"
chmod 700 "$HOME/verificacao"
# Uma rodada por vez: trocar a árvore debaixo de um test:db em curso daria
# veredito de um código que não existe.
exec 9>"$HOME/verificacao/.verificar.lock"
flock -n 9 || { echo "outra rodada do verificar está em andamento" >&2; exit 4; }
cd "$HOME/verificacao"
if [ ! -d hiperbold-crm/.git ]; then
  echo "   clone novo de $2"
  git clone -q "$2" hiperbold-crm
fi
cd hiperbold-crm
git fetch -q --prune origin
git rev-parse --verify --quiet "refs/remotes/origin/$1" >/dev/null \
  || { echo "branch $1 não existe no GitHub (falta o push?)" >&2; exit 3; }
git checkout -q -f -B "$1" "origin/$1"
git reset -q --hard "origin/$1"
# Sem -x: o node_modules (ignorado) fica, e o install seguinte é rápido.
git clean -q -ffd
echo "   $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse HEAD)"
REMOTO

if [ "$LOCAL" = 1 ]; then
  echo "== usando a verificar-remoto.sh deste checkout (--script-local)"
  "${SSH[@]}" 'umask 077; cat > "$HOME/verificacao/.verificar-remoto.sh"' < "$AQUI/verificar-remoto.sh"
  SCRIPT='$HOME/verificacao/.verificar-remoto.sh'
else
  SCRIPT='$HOME/verificacao/hiperbold-crm/hiperbold/scripts/verificar-remoto.sh'
  "${SSH[@]}" "test -f $SCRIPT" || {
    echo "a branch $BRANCH não tem hiperbold/scripts/verificar-remoto.sh; rode com --script-local" >&2
    exit 3
  }
fi

# stdin fechado: a parte remota usa docker e não pode ler o terminal.
"${SSH[@]}" "bash $SCRIPT" < /dev/null
