#!/usr/bin/env bash
# Parte remota do `verificar`: roda NO servidor hiperbold-homolog (WSL), depois
# que o verificar.sh do Mac já pôs o clone da verificação na branch pedida.
# O verificar.sh a dispara com setsid/nohup: a queda do ssh não mata a rodada.
#
# Etapas (depois do install, todas AO MESMO TEMPO, cada uma com o seu log):
#   install    pnpm install --frozen-lockfile (o pnpm da versão de packageManager)
#   typecheck  pnpm typecheck (NODE_OPTIONS=--max-old-space-size=8192)
#   lint       pnpm lint
#   unit       pnpm test:unit (a suíte inteira, os dois projetos)
#   db-1..N    pnpm test:db --shard=i/N, cada parte com o seu Postgres efêmero
#              em 127.0.0.1:16500+i-1; no fim, a união das partes tem de ser a
#              lista inteira de tests/invariants (senão a etapa `db` reprova)
#   e2e        verificar-e2e.sh (as partes do e2e.yml em pistas paralelas)
# Falha no install pula o resto; as outras etapas rodam todas.
#
# Cada etapa vale pelo EXIT CODE (CLAUDE.md, seção Testes), nunca pelo rodapé.
# Logs em <rodada>/<etapa>.log e resumo.txt; <rodada>/fim recebe o exit code
# quando a rodada acaba (é o que o Mac espera). Rodada inteira publica o status
# `verificar/wsl` no commit, pelo gh já autenticado.
#
# Uso: verificar-remoto.sh [--rodada DIR] [--so ALVO] [--sem-status]
#   --rodada DIR   pasta da rodada (o verificar.sh cria; sem ela, uma nova)
#   --so ALVO      só uma etapa (install|typecheck|lint|unit|db|e2e) ou um
#                  arquivo de teste: tests/invariants/*.test.ts (db),
#                  tests/e2e/*.spec.ts (e2e) ou outro *.test.ts[x] (unit).
#                  Nunca publica status: um arquivo verde não é selo do commit.
#   --sem-status   rodada inteira sem publicar status (medição, ensaio)
# Variáveis: VERIFICAR_DB_PARTES (padrão 6), VERIFICAR_UNIT_WORKERS (padrão 8),
# VERIFICAR_E2E_PISTAS (padrão em verificar-e2e.sh).
#
# Memória (19 GB, dividida com a homologação e o Supabase de dev): tudo junto
# levou o servidor a load 200 e 0,8 GB livres. Por isso há portões: o build do
# e2e espera o typecheck; o unit espera o build; tudo roda com nice 10.
set -uo pipefail

VERIF_DIR="${VERIFICAR_DIR:-$HOME/verificacao}"
CLONE="${VERIFICAR_CLONE:-$VERIF_DIR/hiperbold-crm}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
REPO_GH="Hiperbold-Company/hiperbold-crm"
CONTEXTO="verificar/wsl"
# Portas da verificação = as da prévia do CRM + 100 (~/.claude/regras/hiperbold-homolog.md).
PORTA_DB_BASE=16500   # Postgres efêmero de cada parte do test:db (só 127.0.0.1): 16500-16509
DB_PARTES="${VERIFICAR_DB_PARTES:-6}"

RODADA=""
SO=""
SEM_STATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    --rodada) RODADA="${2:-}"; shift 2 ;;
    --so) SO="${2:-}"; [ -n "$SO" ] || { echo "--so pede um alvo" >&2; exit 2; }; shift 2 ;;
    --sem-status) SEM_STATUS=1; shift ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$SO" ] && { ! [[ "$SO" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$SO" == -* || "$SO" == *..* ]]; }; then
  echo "alvo recusado: $SO" >&2; exit 2
fi
[[ "$DB_PARTES" =~ ^[0-9]+$ ]] && [ "$DB_PARTES" -ge 1 ] && [ "$DB_PARTES" -le 10 ] \
  || { echo "VERIFICAR_DB_PARTES tem de ser de 1 a 10 (portas 16500-16509)" >&2; exit 2; }

[ -d "$CLONE/.git" ] || { echo "ERRO: clone não encontrado em $CLONE" >&2; exit 1; }
cd "$CLONE"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"   # completo: a API de statuses não aceita o curto
if [ -z "$RODADA" ]; then
  RODADA="$VERIF_DIR/logs/$(date +%Y%m%d-%H%M%S)-${SHA:0:10}"
fi
mkdir -p "$RODADA"
LOGS="$RODADA"
RESUMO="$LOGS/resumo.txt"
: > "$RESUMO"
rm -f "$LOGS/fim"
INICIO=$(date +%s)
info() { printf '%s\n' "$*" | tee -a "$RESUMO"; }
terminar() { echo "$1" > "$LOGS/fim"; exit "$1"; }

# Uma rodada por vez: trocar a árvore debaixo de um test:db em curso daria
# veredito de um código que não existe. O fd 9 não passa para os filhos longos
# (`9>&-` em cada etapa), senão um processo esquecido seguraria a trava.
exec 9>"$VERIF_DIR/.verificar.lock"
flock -n 9 || { info "ERRO: outra rodada do verificar está em andamento"; terminar 4; }

PUBLICA=1
[ -n "$SO" ] && PUBLICA=0
[ "$SEM_STATUS" = 1 ] && PUBLICA=0
PUBLICADO=0
publicar() { # estado, descrição
  local estado="$1" desc="$2"
  [ "$PUBLICA" = 1 ] || { info "status não publicado ($([ -n "$SO" ] && echo "--so $SO" || echo --sem-status)): seria $estado"; PUBLICADO=1; return 0; }
  desc="${desc:0:140}"   # limite da API
  if gh api -X POST "repos/$REPO_GH/statuses/$SHA" \
      -f state="$estado" -f context="$CONTEXTO" -f description="$desc" >/dev/null 2>>"$LOGS/gh.log"; then
    PUBLICADO=1
    info "status $CONTEXTO publicado: $estado ($desc)"
  else
    info "ERRO: não consegui publicar o status (ver $LOGS/gh.log)"
    return 1
  fi
}

FILHOS=()
encerrar_filhos() {
  local p
  for p in "${FILHOS[@]}"; do kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true; done
}
# Morreu antes do fim (sinal, erro inesperado): o commit não fica sem resposta.
trap 'encerrar_filhos; [ "$PUBLICADO" = 1 ] || publicar failure "verificar interrompido antes do fim (ver $LOGS)"; [ -f "$LOGS/fim" ] || echo 130 > "$LOGS/fim"' EXIT
trap 'exit 130' INT TERM HUP

info "verificar: $BRANCH @ $SHA${SO:+ (só $SO)}"
info "rodada: $LOGS"

# O pnpm fixado em packageManager, nunca o global do servidor (pnpm 11 trata
# lockfile e scripts de build de outro jeito e daria vermelho falso).
VERSAO_PNPM="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' package.json | head -1)"
[ -n "$VERSAO_PNPM" ] || { info "ERRO: package.json sem packageManager pnpm@"; publicar failure "package.json sem packageManager"; terminar 1; }
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export VERSAO_PNPM
info "pnpm: $(corepack "pnpm@$VERSAO_PNPM" --version 2>&1 | tail -1) (fixado $VERSAO_PNPM); node: $(node -v); núcleos: $(nproc)"
# O pnpm dos scripts (test:db chama vitest pelo PATH do pnpm) tem de ser o mesmo.
mkdir -p "$VERIF_DIR/bin"
cat > "$VERIF_DIR/bin/pnpm" <<EOF
#!/usr/bin/env bash
exec corepack pnpm@$VERSAO_PNPM "\$@"
EOF
chmod +x "$VERIF_DIR/bin/pnpm"
export PATH="$VERIF_DIR/bin:$PATH"
export CI=true

# ── O que roda ────────────────────────────────────────────────────────────────
QUER_TYPECHECK=1; QUER_LINT=1; QUER_UNIT=1; QUER_DB=1; QUER_E2E=1
ARQ_UNIT=""; ARQ_DB=""; ARQ_E2E=""
if [ -n "$SO" ]; then
  QUER_TYPECHECK=0; QUER_LINT=0; QUER_UNIT=0; QUER_DB=0; QUER_E2E=0
  case "$SO" in
    install) ;;
    typecheck) QUER_TYPECHECK=1 ;;
    lint) QUER_LINT=1 ;;
    unit) QUER_UNIT=1 ;;
    db) QUER_DB=1 ;;
    e2e) QUER_E2E=1 ;;
    *)
      [ -f "$SO" ] || { info "ERRO: $SO não existe na branch $BRANCH"; terminar 2; }
      case "$SO" in
        tests/invariants/*.test.ts) QUER_DB=1; ARQ_DB="$SO"; DB_PARTES=1 ;;
        tests/e2e/*.spec.ts) QUER_E2E=1; ARQ_E2E="$SO" ;;
        *.test.ts|*.test.tsx) QUER_UNIT=1; ARQ_UNIT="$SO" ;;
        *) info "ERRO: não sei rodar $SO (etapa ou arquivo .test.ts/.spec.ts)"; terminar 2 ;;
      esac ;;
  esac
fi

# Porta de banco tem de estar livre: nunca derrubar o dono.
if [ "$QUER_DB" = 1 ]; then
  for i in $(seq 1 "$DB_PARTES"); do
    p=$((PORTA_DB_BASE + i - 1))
    if ss -ltnH "sport = :$p" | grep -q .; then
      info "ERRO: a porta $p já está em uso por outro processo; não derrubo"
      publicar failure "porta $p ocupada no servidor; nada rodou"
      terminar 1
    fi
  done
  # Sobra de rodada anterior deste clone (o rótulo é do test-db.sh): com a
  # trava na mão, só pode ser nossa.
  sobras="$(docker ps -aq --filter "label=deskcomm.worktree=$CLONE")"
  [ -z "$sobras" ] || { info "removendo $(wc -w <<<"$sobras") container(s) de test:db esquecidos por rodada anterior"; docker rm -fv $sobras >/dev/null 2>&1 || true; }
fi

mkdir -p "$LOGS/etapas"
# etapa <nome> <comando...>: roda em segundo plano, num grupo de processos próprio.
lancar() {
  local nome="$1"; shift
  echo "== $nome ..."
  setsid bash -c '
    nome="$1"; logs="$2"; shift 2
    t0=$(date +%s)
    if [ -n "${ESPERAR_ARQ:-}" ]; then
      echo "esperando $ESPERAR_ARQ" > "$logs/$nome.log"
      while [ ! -f "$ESPERAR_ARQ" ]; do sleep 5; done
    fi
    nice -n 10 "$@" >> "$logs/$nome.log" 2>&1 < /dev/null
    rc=$?
    echo "$rc $(( $(date +%s) - t0 ))" > "$logs/etapas/$nome"
  ' _ "$nome" "$LOGS" "$@" 9>&- &
  FILHOS+=("$!")
}
FALHAS=()
TEMPOS=()
registrar() { # nome
  local nome="$1" rc dur
  if [ -f "$LOGS/etapas/$nome" ]; then read -r rc dur < "$LOGS/etapas/$nome"; else rc=99; dur=0; fi
  TEMPOS+=("$nome=${dur}s")
  if [ "$rc" = 0 ]; then
    info "$nome: ok em ${dur}s"
  else
    info "$nome: FALHOU em ${dur}s (exit $rc, log $LOGS/$nome.log)"
    FALHAS+=("$nome")
  fi
}

lancar install pnpm install --frozen-lockfile
wait "${FILHOS[@]}"; FILHOS=()
registrar install
if [ "${#FALHAS[@]}" -gt 0 ]; then
  info "install falhou: o resto não rodou"
  TOTAL=$(( $(date +%s) - INICIO ))
  publicar failure "install falhou ($((TOTAL / 60))min)"
  terminar 1
fi

ETAPAS=()
# Memória usada/disponível a cada 10 s: é o que diz quantas partes cabem.
( while :; do echo "$(date +%s) $(free -m | awk '/^Mem:/ {print $3, $7}')"; sleep 10; done ) > "$LOGS/memoria.log" 9>&- &
AMOSTRADOR=$!
# GH_TOKEN como no CI (o test:db consulta a última release); nunca vai para o log.
GH_TOKEN_CI="$(gh auth token 2>/dev/null || true)"

if [ "$QUER_E2E" = 1 ]; then
  rm -f "$VERIF_DIR/e2e/build.fim"   # o portão do unit: nunca o de uma rodada anterior
  # Primeiro: a pista sobe Supabase e monta o app, e é a etapa mais longa.
  # O build espera o typecheck acabar (dois processos de 6-8 GB não cabem juntos).
  lancar e2e env VERIFICAR_E2E_ESPERAR="$([ "$QUER_TYPECHECK" = 1 ] && echo "$LOGS/etapas/typecheck")" \
    bash "$AQUI/verificar-e2e.sh" --clone "$CLONE" --logs "$LOGS/e2e" ${ARQ_E2E:+--spec "$ARQ_E2E"}
  ETAPAS+=(e2e)
fi
if [ "$QUER_TYPECHECK" = 1 ]; then
  lancar typecheck env NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck; ETAPAS+=(typecheck)
fi
if [ "$QUER_LINT" = 1 ]; then
  lancar lint pnpm lint; ETAPAS+=(lint)
fi
if [ "$QUER_DB" = 1 ]; then
  for i in $(seq 1 "$DB_PARTES"); do
    if [ -n "$ARQ_DB" ]; then
      lancar "db-$i" env TEST_DB_PORT="$PORTA_DB_BASE" GH_TOKEN="$GH_TOKEN_CI" pnpm test:db "$ARQ_DB"
    else
      lancar "db-$i" env TEST_DB_PORT=$((PORTA_DB_BASE + i - 1)) GH_TOKEN="$GH_TOKEN_CI" \
        pnpm test:db --shard="$i/$DB_PARTES" --reporter=default --reporter=json --outputFile="$LOGS/db-$i.json"
    fi
    ETAPAS+=("db-$i")
  done
fi
if [ "$QUER_UNIT" = 1 ]; then
  if [ -n "$ARQ_UNIT" ]; then
    lancar unit pnpm vitest run "$ARQ_UNIT"
  else
    # Com o e2e na rodada, o unit só começa depois do build (o next build ocupa 6 GB).
    ESPERAR_ARQ="$([ "$QUER_E2E" = 1 ] && echo "$VERIF_DIR/e2e/build.fim")" \
      lancar unit pnpm test:unit --maxWorkers="${VERIFICAR_UNIT_WORKERS:-8}"
  fi
  ETAPAS+=(unit)
fi

wait "${FILHOS[@]}"; FILHOS=()
kill "$AMOSTRADOR" 2>/dev/null
for e in "${ETAPAS[@]}"; do registrar "$e"; done
info "memória: pico de $(awk 'BEGIN {m=0} $2>m {m=$2} END {print m}' "$LOGS/memoria.log") MB usados, mínimo de $(awk 'BEGIN {m=1e9} $3<m {m=$3} END {print m}' "$LOGS/memoria.log") MB disponíveis"

# As partes do test:db juntas têm de ser a suíte inteira, uma vez só. O `vitest
# list` ignora --shard, então a prova é o relatório json de cada parte.
if [ "$QUER_DB" = 1 ] && [ -z "$ARQ_DB" ] && [ "$DB_PARTES" -gt 1 ]; then
  esperado="$(pnpm exec vitest list --config vitest.db.config.ts --filesOnly 2>/dev/null | sed "s#^$CLONE/##" | sort -u)"
  rodado="$(for i in $(seq 1 "$DB_PARTES"); do
      [ -f "$LOGS/db-$i.json" ] && node -e 'for (const r of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).testResults) console.log(r.name)' "$LOGS/db-$i.json"
    done | sed "s#^$CLONE/##" | sort)"
  n_esp=$(grep -c . <<<"$esperado"); n_rod=$(grep -c . <<<"$rodado"); n_uni=$(sort -u <<<"$rodado" | grep -c .)
  if [ "$n_esp" -gt 100 ] && [ "$n_esp" = "$n_rod" ] && [ "$n_rod" = "$n_uni" ] && [ "$esperado" = "$(sort -u <<<"$rodado")" ]; then
    info "db: as $DB_PARTES partes cobriram os $n_esp arquivos, cada um uma vez"
  else
    info "db: FALHOU a conferência das partes (lista $n_esp, rodados $n_rod, distintos $n_uni)"
    FALHAS+=("db-cobertura")
  fi
fi

# Primeira linha de erro de cada etapa vermelha, para o resumo.
for f in "${FALHAS[@]}"; do
  [ -f "$LOGS/$f.log" ] || continue
  primeira="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/$f.log" | grep -aE -m1 '^ *FAIL |✘|Error:|ERRO:|ERR_|FATAL' | cut -c1-200)"
  info "   $f: ${primeira:-sem linha de erro reconhecível; ver o log}"
done
[ -f "$LOGS/e2e/resumo.txt" ] && sed 's/^/   /' "$LOGS/e2e/resumo.txt" | tee -a "$RESUMO" >/dev/null

TOTAL=$(( $(date +%s) - INICIO ))
info "tempos: ${TEMPOS[*]} total=${TOTAL}s"

if [ "${#FALHAS[@]}" = 0 ]; then
  publicar success "install, typecheck, lint, unit, db e e2e ok em $((TOTAL / 60))min"
  terminar 0
else
  publicar failure "falhou: ${FALHAS[*]} ($((TOTAL / 60))min)"
  terminar 1
fi
