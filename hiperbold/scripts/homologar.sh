#!/usr/bin/env bash
# shellcheck disable=SC2016  # $HOME entre aspas simples expande NO SERVIDOR, de propósito
# homologar <branch> [--zerar] [--script-local]
#
# Roda no Mac. Pelo SSH, põe o clone da homologação (~/homologacao/hiperbold-crm
# no servidor hiperbold-homolog) na branch pedida, igual ao GitHub (fetch +
# checkout + reset --hard: esse clone é SÓ da homologação), e executa a parte
# remota, hiperbold/scripts/homologar-remoto.sh, daquela mesma branch.
#
#   --zerar         recria o banco da homologação do zero (só o dela)
#   --script-local  executa a homologar-remoto.sh DESTE checkout em vez da que
#                   está na branch (para testar o próprio script antes do push,
#                   ou homologar uma branch que ainda não tem o script)
#
# Ver hiperbold/homologacao.md.
set -euo pipefail

HOST="${HOMOLOG_HOST:-filipe@hiperbold-homolog}"
AQUI="$(cd "$(dirname "$0")" && pwd)"

uso() { sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; }

BRANCH=""
REMOTO_ARGS=()
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --zerar) REMOTO_ARGS+=(--zerar) ;;
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

# Só para teste, quando a 3490 estiver ocupada: HOMOLOG_PORTA_WEB=<porta>.
PREFIXO=""
if [ -n "${HOMOLOG_PORTA_WEB:-}" ]; then
  [[ "$HOMOLOG_PORTA_WEB" =~ ^[0-9]{4,5}$ ]] || { echo "HOMOLOG_PORTA_WEB inválida" >&2; exit 2; }
  PREFIXO="HOMOLOG_PORTA_WEB=$HOMOLOG_PORTA_WEB "
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

echo "== clone da homologação -> origin/$BRANCH"
"${SSH[@]}" bash -s -- "$BRANCH" <<'REMOTO'
set -euo pipefail
cd "$HOME/homologacao/hiperbold-crm"
git fetch --prune origin
git rev-parse --verify --quiet "refs/remotes/origin/$1" >/dev/null \
  || { echo "branch $1 não existe no GitHub (falta o push?)" >&2; exit 3; }
git checkout -q -f -B "$1" "origin/$1"
git reset -q --hard "origin/$1"
git clean -q -ffd
echo "   $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short=10 HEAD)"
REMOTO

if [ "$LOCAL" = 1 ]; then
  echo "== usando a homologar-remoto.sh deste checkout (--script-local)"
  "${SSH[@]}" 'umask 077; cat > "$HOME/homologacao/.homologar-remoto.sh"' < "$AQUI/homologar-remoto.sh"
  SCRIPT='$HOME/homologacao/.homologar-remoto.sh'
else
  SCRIPT='$HOME/homologacao/hiperbold-crm/hiperbold/scripts/homologar-remoto.sh'
  "${SSH[@]}" "test -f $SCRIPT" || {
    echo "a branch $BRANCH não tem hiperbold/scripts/homologar-remoto.sh; rode com --script-local" >&2
    exit 3
  }
fi

# stdin fechado: a parte remota usa `docker exec -i` e não pode ler o terminal.
"${SSH[@]}" "${PREFIXO}bash $SCRIPT ${REMOTO_ARGS[*]:-}" < /dev/null
