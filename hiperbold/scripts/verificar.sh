#!/usr/bin/env bash
# shellcheck disable=SC2016  # $HOME entre aspas simples expande NO SERVIDOR, de propósito
# verificar <branch> [--script-local] [--so ALVO] [--sem-status] [--sem-esperar]
# verificar --acompanhar [PASTA-DA-RODADA]
#
# Roda no Mac. Pelo SSH, põe o clone da verificação (~/verificacao/hiperbold-crm
# no servidor hiperbold-homolog) na branch pedida, igual ao GitHub (fetch +
# checkout + reset --hard: esse clone é SÓ da verificação), e dispara a parte
# remota (hiperbold/scripts/verificar-remoto.sh) com setsid/nohup NO servidor:
# a queda do ssh ou do Mac não mata a rodada. O Mac só acompanha o resumo e,
# no fim, devolve o exit code da rodada. A rodada inteira grava o status
# `verificar/wsl` no commit do GitHub.
#
#   --script-local  usa os verificar-*.sh DESTE checkout em vez dos da branch
#   --so ALVO       só uma etapa (install|typecheck|lint|unit|db|e2e) ou um
#                   arquivo: tests/invariants/x.test.ts, tests/e2e/x.spec.ts ou
#                   outro *.test.ts[x]. Não publica status.
#   --sem-status    rodada inteira sem publicar status (medição)
#   --sem-esperar   dispara e sai; acompanhe depois com --acompanhar
#   --acompanhar    volta a acompanhar a última rodada (ou a pasta dada)
#
# Ver hiperbold/verificacao.md.
set -euo pipefail

HOST="${VERIFICAR_HOST:-filipe@hiperbold-homolog}"
REPO_URL="https://github.com/Hiperbold-Company/hiperbold-crm.git"
AQUI="$(cd "$(dirname "$0")" && pwd)"
INTERVALO="${VERIFICAR_INTERVALO:-20}"

uso() { sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; }

BRANCH=""
LOCAL=0
SO=""
SEM_STATUS=0
ESPERAR=1
ACOMPANHAR=0
RODADA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --script-local) LOCAL=1 ;;
    --sem-status) SEM_STATUS=1 ;;
    --sem-esperar) ESPERAR=0 ;;
    --so) SO="${2:-}"; [ -n "$SO" ] || { echo "--so pede um alvo" >&2; exit 2; }; shift ;;
    --acompanhar) ACOMPANHAR=1; if [ -n "${2:-}" ] && [[ "$2" != -* ]]; then RODADA="$2"; shift; fi ;;
    -h|--help) uso; exit 0 ;;
    -*) echo "opção desconhecida: $1" >&2; uso >&2; exit 2 ;;
    *)
      [ -z "$BRANCH" ] || { echo "só uma branch por vez" >&2; exit 2; }
      BRANCH="$1" ;;
  esac
  shift
done
# Os nomes vão para um comando remoto: só o que nome de branch e de arquivo costuma ter.
seguro() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$1" != -* && "$1" != *..* ]]; }
if [ "$ACOMPANHAR" = 1 ]; then
  [ -z "$RODADA" ] || seguro "$RODADA" || { echo "pasta recusada: $RODADA" >&2; exit 2; }
else
  [ -n "$BRANCH" ] || { uso >&2; exit 2; }
  seguro "$BRANCH" || { echo "nome de branch recusado: $BRANCH" >&2; exit 2; }
  [ -z "$SO" ] || seguro "$SO" || { echo "alvo recusado: $SO" >&2; exit 2; }
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 "$HOST")

acompanhar() { # pasta da rodada no servidor
  local rodada="$1" visto=0 falhas_ssh=0 mortes=0 saida rc
  echo "== acompanhando $rodada (a rodada segue no servidor se esta conexão cair)"
  while :; do
    if saida="$("${SSH[@]}" "f=$rodada/resumo.txt; [ -f \$f ] && tail -n +$((visto + 1)) \$f; echo __LINHAS__ \$( [ -f \$f ] && wc -l < \$f || echo 0); [ -f $rodada/fim ] && echo __FIM__ \$(cat $rodada/fim); flock -n \$HOME/verificacao/.verificar.lock true && echo __PARADA__; true" < /dev/null 2>/dev/null)"; then
      falhas_ssh=0
      printf '%s\n' "$saida" | grep -vE '^__(LINHAS|FIM|PARADA)__' || true
      visto="$(printf '%s\n' "$saida" | sed -n 's/^__LINHAS__ //p' | tail -1)"
      visto="${visto:-0}"
      rc="$(printf '%s\n' "$saida" | sed -n 's/^__FIM__ //p' | tail -1)"
      if [ -n "$rc" ]; then
        echo "== fim da rodada: exit $rc (logs em $HOST:$rodada)"
        return "$rc"
      fi
      # Ninguém segura a trava e não há `fim`: a rodada morreu sem se despedir
      # (kill -9, servidor reiniciado). Duas leituras seguidas, para não
      # confundir com o instante entre o disparo e a trava.
      if printf '%s\n' "$saida" | grep -q '^__PARADA__'; then
        mortes=$((mortes + 1))
        [ "$mortes" -lt 2 ] || { echo "== a rodada parou sem gravar o fim (ver $HOST:$rodada/saida.log)" >&2; return 5; }
      else
        mortes=0
      fi
    else
      falhas_ssh=$((falhas_ssh + 1))
      echo "   (ssh falhou $falhas_ssh vez(es); a rodada continua no servidor; tento de novo)" >&2
    fi
    sleep "$INTERVALO"
  done
}

if [ "$ACOMPANHAR" = 1 ]; then
  [ -n "$RODADA" ] || RODADA="$("${SSH[@]}" 'readlink -f "$HOME/verificacao/logs/ultima"' < /dev/null)"
  [ -n "$RODADA" ] || { echo "nenhuma rodada encontrada" >&2; exit 3; }
  acompanhar "$RODADA"
  exit $?
fi

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
  echo "== usando os verificar-*.sh deste checkout (--script-local)"
  "${SSH[@]}" 'umask 077; mkdir -p "$HOME/verificacao/.scripts"' < /dev/null
  for f in verificar-remoto.sh verificar-e2e.sh; do
    "${SSH[@]}" "umask 077; cat > \"\$HOME/verificacao/.scripts/$f\"" < "$AQUI/$f"
  done
  SCRIPT='$HOME/verificacao/.scripts/verificar-remoto.sh'
else
  SCRIPT='$HOME/verificacao/hiperbold-crm/hiperbold/scripts/verificar-remoto.sh'
  "${SSH[@]}" "test -f $SCRIPT" < /dev/null || {
    echo "a branch $BRANCH não tem hiperbold/scripts/verificar-remoto.sh; rode com --script-local" >&2
    exit 3
  }
fi

OPCOES=""
[ -n "$SO" ] && OPCOES="$OPCOES --so $SO"
[ "$SEM_STATUS" = 1 ] && OPCOES="$OPCOES --sem-status"

# Dispara desacoplado: setsid + nohup, stdin fechado, saída num arquivo da rodada.
RODADA="$("${SSH[@]}" "set -e
  sha=\$(git -C \$HOME/verificacao/hiperbold-crm rev-parse HEAD)
  r=\$HOME/verificacao/logs/\$(date +%Y%m%d-%H%M%S)-\${sha:0:10}
  mkdir -p \$r
  ln -sfn \$r \$HOME/verificacao/logs/ultima
  setsid nohup bash $SCRIPT --rodada \$r$OPCOES > \$r/saida.log 2>&1 < /dev/null &
  echo \$r" < /dev/null)"
echo "== rodada disparada no servidor: $RODADA"

if [ "$ESPERAR" = 0 ]; then
  echo "   acompanhe com: bash hiperbold/scripts/verificar.sh --acompanhar $RODADA"
  exit 0
fi
acompanhar "$RODADA"
