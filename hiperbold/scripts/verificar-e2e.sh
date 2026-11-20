#!/usr/bin/env bash
# E2E do `verificar` no servidor hiperbold-homolog: as partes do e2e.yml
# (SPECS_PARTE_*, lidas do e2e.yml da própria branch) em PISTAS paralelas.
# Chamado pelo verificar-remoto.sh; não publica status.
#
# Cada pista é um par:
#   - um Supabase da CLI (2.117.0, a do CI) no projeto `hiperbold-verificacao-<n>`,
#     numa rede Docker com host_binding 127.0.0.<n> e portas 16510-16514
#     (shadow 16510, API 16511, banco 16512, Studio 16513 desligado, e-mails 16514);
#   - um contêiner da imagem do Playwright (versão do repo), na rede da pista,
#     com rede PRÓPRIA: dentro dele o Supabase aparece em 127.0.0.1:54321/54322/
#     54324 (socat), o app em localhost:3001, e os dublês das specs (3995-3999,
#     56331), o WAHA (3000) e o Redis (6379/8079) da parte 4 nas portas fixas do
#     e2e.yml — sem tocar nas portas do servidor e sem colidir com a pista ao lado.
# Como dentro de toda pista o Supabase tem o mesmo endereço e as mesmas chaves
# (as padrão da CLI; conferido), um `next build` serve todas.
#
# O que roda dentro da pista é o que o e2e-parte do e2e.yml roda, na mesma ordem:
# e2e:env, isolamento da parte 8, provas da parte 1, VPS fresca da parte 4
# (WAHA, Redis, dublê de SaaS, bootstrap-owner), sementes, playwright --workers=1.
# Fica de fora: os passos de evidência (gerar tipos do banco, upload) e os
# orçamentos de relógio do GitHub.
#
# Uso: verificar-e2e.sh --clone DIR --logs DIR [--spec tests/e2e/x.spec.ts]
#   VERIFICAR_E2E_PISTAS   pistas em paralelo (padrão 3; máx. 8)
#   VERIFICAR_E2E_ESPERAR  arquivo que o build espera existir (fim do typecheck)
set -uo pipefail

if [ "${1:-}" = "--dentro" ]; then MODO=dentro; else MODO=fora; fi

# ════════════════════════════════════════════════════════════════════════════
# DENTRO do contêiner da pista (docker exec). Árvore em /w.
# ════════════════════════════════════════════════════════════════════════════
if [ "$MODO" = dentro ]; then
  shift
  ACAO="$1"; PARTE="${2:-0}"; LISTA_ARQ="${3:-}"
  set -e
  cd /w
  export PATH="/verif/bin:$PATH" HOME=/tmp/casa CI=true NEXT_TELEMETRY_DISABLED=1
  mkdir -p "$HOME"
  echo "node $(node -v), pnpm $(pnpm --version), parte $PARTE ($ACAO)"
  pnpm e2e:env
  if [ "$ACAO" = build ]; then
    NODE_OPTIONS=--max-old-space-size=6144 SENTRY_DSN=off pnpm e2e:build
    exit 0
  fi

  if [ "$PARTE" = 8 ]; then
    if grep -Eq '^[[:space:]]*(META_ADS_GRAPH_BASE_URL|META_GRAPH_BASE_URL|WAHA_WEBHOOK_REQUIRE_SIGNATURE)[[:space:]]*=' .env.e2e; then
      echo '.env.e2e contém configuração que teria precedência no next start causal'; exit 1
    fi
    grep -qx 'WAHA_API_BASE_URL=http://127.0.0.1:3999' .env.e2e || { echo 'WAHA_API_BASE_URL da parte causal não é o dublê local'; exit 1; }
    export META_ADS_GRAPH_BASE_URL=http://127.0.0.1:3995 META_GRAPH_BASE_URL=http://127.0.0.1:9 WAHA_WEBHOOK_REQUIRE_SIGNATURE=true
  fi
  publicar_env() { # o "Publicar o .env.e2e no ambiente do job"
    local k v
    while IFS= read -r linha; do
      case "$linha" in ''|'#'*) continue ;; esac
      k="${linha%%=*}"; v="${linha#*=}"
      [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "$k=$v"
    done < "$1"
  }
  publicar_env .env.e2e

  if [ "$PARTE" = 1 ]; then
    mkdir -p evidence/historico-chat-invalido
    pnpm exec tsx scripts/provas/historico-chat-invalido.ts --executar-banco-local \
      | tee evidence/historico-chat-invalido/recibo.jsonl
    pnpm exec tsx tests/provas/media-derive-isolamento.ts
  fi
  if [ "$PARTE" = 6 ]; then
    ffmpeg -hide_banner -encoders | grep -E ' (aac|libopus) '
    test "$(ffmpeg -hide_banner -encoders | grep -cE ' (aac|libopus) ')" -ge 2
  fi

  if [ "$PARTE" = 4 ]; then
    nohup node scripts/duble-saas-e2e.mjs >/tmp/duble-saas.log 2>&1 &
    for _ in $(seq 1 30); do curl -sf http://127.0.0.1:3997/__duble/saude >/dev/null && break; sleep 1; done
    cat /tmp/duble-saas.log
    bash scripts/duble-saas-e2e-smoke.sh
    {
      echo "WAHA_API_BASE_URL=http://127.0.0.1:3000"
      echo "UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079"
      echo "UPSTASH_REDIS_REST_TOKEN=e2e-token-nao-e-segredo"
      echo "RESEND_API_BASE_URL=http://127.0.0.1:3997"
      echo "RESEND_API_KEY="
      echo "NUVEMSHOP_AUTH_BASE=http://127.0.0.1:3997"
      echo "NUVEMSHOP_API_BASE=http://127.0.0.1:3997"
      echo "NUVEMSHOP_CLIENT_ID=e2e-app-id"
      echo "NUVEMSHOP_CLIENT_SECRET=e2e-placeholder-nao-e-segredo"
    } > /tmp/vps-fresca.env
    chaves=$(cut -d= -f1 /tmp/vps-fresca.env | paste -sd'|' -)
    grep -vE "^(${chaves})=" .env.e2e > /tmp/env-e2e-sem-parte-4
    cat /tmp/env-e2e-sem-parte-4 /tmp/vps-fresca.env > .env.e2e
    publicar_env /tmp/vps-fresca.env
    ok=""
    for _ in $(seq 1 30); do
      curl -s -X POST -H "Authorization: Bearer e2e-token-nao-e-segredo" -H "Content-Type: application/json" \
        -d '["PING"]' http://127.0.0.1:8079/ 2>/dev/null | grep -q PONG && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "Redis (REST do Upstash) não respondeu PONG em 30s"; exit 1; }
    cp .env.e2e .env.local
    ok=""
    for _ in $(seq 1 90); do
      p=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ping || true)
      s=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $WAHA_API_KEY" "http://127.0.0.1:3000/api/sessions?all=true" || true)
      [ "$p" = 200 ] && [ "$s" = 200 ] && { ok=1; echo "WAHA pronto"; break; }
      sleep 2
    done
    [ -n "$ok" ] || { echo "WAHA não respondeu em 180s: /ping=$p /api/sessions=$s"; exit 1; }
    pnpm exec tsx scripts/bootstrap-owner.ts
  else
    cp .env.e2e .env.local
    pnpm exec tsx scripts/seed-e2e-credentials.ts
  fi
  [ "$PARTE" = 8 ] && pnpm exec tsx scripts/seed-e2e-nascimento-do-lead.ts
  if [ "$PARTE" != 4 ]; then
    pnpm exec tsx scripts/seed-e2e-escalacao.ts
    pnpm exec tsx --env-file=.env.local scripts/seed-e2e-capacidades-ausentes.ts
    pnpm exec tsx scripts/seed-e2e-followup-agent.ts
    pnpm exec tsx scripts/seed-e2e-catalogo-openrouter.ts
  fi

  # shellcheck disable=SC2046  # a lista é separada por espaço, como no e2e.yml
  set +e
  AUTH_RATE_LIMIT_LOGIN_IP=1000 SENTRY_DSN=off timeout -k 30 --signal=TERM 2700 \
    pnpm exec playwright test --workers=1 $(cat "$LISTA_ARQ") --reporter=list
  exit $?
fi

# ════════════════════════════════════════════════════════════════════════════
# FORA (no servidor): stacks, build, pistas.
# ════════════════════════════════════════════════════════════════════════════
CLONE=""; LOGS=""; SPEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --clone) CLONE="$2"; shift 2 ;;
    --logs) LOGS="$2"; shift 2 ;;
    --spec) SPEC="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -d "$CLONE/.git" ] && [ -n "$LOGS" ] || { echo "uso: $0 --clone DIR --logs DIR [--spec X]" >&2; exit 2; }
ESTE="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
mkdir -p "$LOGS"
RES="$LOGS/resumo.txt"; : > "$RES"
diz() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
res() { printf '%s\n' "$*" >> "$RES"; diz "$*"; }

E2E_DIR="$(dirname "$CLONE")/e2e"
ARVORE="$E2E_DIR/arvore"
mkdir -p "$E2E_DIR"
SHA="$(git -C "$CLONE" rev-parse HEAD)"
PISTAS="${VERIFICAR_E2E_PISTAS:-3}"
[[ "$PISTAS" =~ ^[1-8]$ ]] || { echo "VERIFICAR_E2E_PISTAS de 1 a 8" >&2; exit 2; }
SB_VERSAO=2.117.0
PREFIXO=hiperbold-verificacao   # projeto, rede e contêineres: só o que começa assim é nosso
WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2
REDIS_IMAGE=redis:7-alpine
SRH_IMAGE=hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150

# ── faxina: só o que é nosso (prefixo), com a trava do verificar na mão ──────
faxina() {
  local c n v
  c="$(docker ps -aq --filter "name=^${PREFIXO}-e2e-")"
  [ -z "$c" ] || docker rm -fv $c >/dev/null 2>&1
  for n in $(seq 1 8); do
    if docker ps -aq --filter "label=com.supabase.cli.project=${PREFIXO}-${n}" | grep -q .; then
      sb "$n" stop --no-backup >/dev/null 2>&1 || true
      c="$(docker ps -aq --filter "label=com.supabase.cli.project=${PREFIXO}-${n}")"
      [ -z "$c" ] || docker rm -fv $c >/dev/null 2>&1
    fi
    v="$(docker volume ls -q --filter "label=com.supabase.cli.project=${PREFIXO}-${n}")"
    [ -z "$v" ] || docker volume rm $v >/dev/null 2>&1
    docker network rm "${PREFIXO}-${n}" >/dev/null 2>&1 || true
  done
}
sb() { # n, args...
  local n="$1"; shift
  (cd "$E2E_DIR/sb-$n" && npx --yes "supabase@$SB_VERSAO" "$@" --workdir "$E2E_DIR/sb-$n")
}
PIDS=()
# build.fim é o portão do unit no verificar-remoto.sh: nunca sair sem ele.
trap 'for p in "${PIDS[@]}"; do pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; done; [ -f "$E2E_DIR/build.fim" ] || echo "1 0" > "$E2E_DIR/build.fim"; faxina' EXIT
trap 'exit 130' INT TERM HUP

# ── partes do e2e.yml ────────────────────────────────────────────────────────
python3 - "$CLONE/.github/workflows/e2e.yml" "$E2E_DIR/listas" <<'PY' || { res "ERRO: não li as SPECS_PARTE_* do e2e.yml"; exit 1; }
import os, re, sys
y = open(sys.argv[1], encoding="utf-8").read()
os.makedirs(sys.argv[2], exist_ok=True)
for f in os.listdir(sys.argv[2]): os.remove(os.path.join(sys.argv[2], f))
achou = 0
for nome, corpo in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)', y):
    specs = re.findall(r'[A-Za-z0-9/_.-]+\.spec\.ts', corpo)
    if not specs: continue
    open(os.path.join(sys.argv[2], "parte-" + nome.split("_")[-1] + ".txt"), "w").write(" ".join(specs))
    achou += 1
sys.exit(0 if achou else 1)
PY
TODAS="$(ls "$E2E_DIR/listas" | sed -nE 's/^parte-([0-9]+)\.txt$/\1/p' | sort -n)"
if [ -n "$SPEC" ]; then
  PARTE_DA_SPEC=""
  for p in $TODAS; do tr ' ' '\n' < "$E2E_DIR/listas/parte-$p.txt" | grep -qxF "${SPEC#tests/e2e/}" && PARTE_DA_SPEC="$p"; done
  [ -n "$PARTE_DA_SPEC" ] || { res "ERRO: $SPEC não está em nenhuma SPECS_PARTE_* do e2e.yml (o CI não a roda)"; exit 1; }
  printf '%s' "$SPEC" > "$E2E_DIR/listas/parte-$PARTE_DA_SPEC.txt"
  TODAS="$PARTE_DA_SPEC"; PISTAS=1
  res "só $SPEC (parte $PARTE_DA_SPEC, com o preparo dela)"
fi

# ── distribuição: maior primeiro, na pista menos carregada ───────────────────
# Peso = último tempo medido aqui (tempos.txt), senão o do GitHub em 19/11/2026.
peso() {
  local m; m="$(awk -v p="$1" '$1==p {v=$2} END {print v}' "$E2E_DIR/tempos.txt" 2>/dev/null)"
  [ -n "$m" ] && { echo "$m"; return; }
  case "$1" in 1) echo 588;; 2) echo 412;; 3) echo 426;; 4) echo 22;; 5) echo 787;; 6) echo 843;; 7) echo 770;; 8) echo 344;; *) echo 600;; esac
}
N_PARTES=$(wc -w <<<"$TODAS")
[ "$PISTAS" -gt "$N_PARTES" ] && PISTAS="$N_PARTES"
declare -a CARGA PLANO
for i in $(seq 1 "$PISTAS"); do CARGA[$i]=0; PLANO[$i]=""; done
for p in $(for p in $TODAS; do echo "$(peso "$p") $p"; done | sort -rn | awk '{print $2}'); do
  m=1
  for i in $(seq 1 "$PISTAS"); do [ "${CARGA[$i]}" -lt "${CARGA[$m]}" ] && m=$i; done
  # trocar de parte custa um Supabase novo (~120 s)
  [ -n "${PLANO[$m]}" ] && CARGA[$m]=$(( CARGA[m] + 120 ))
  CARGA[$m]=$(( CARGA[m] + $(peso "$p") )); PLANO[$m]="${PLANO[$m]} $p"
done
for i in $(seq 1 "$PISTAS"); do res "pista $i: partes${PLANO[$i]} (previsão ${CARGA[$i]}s)"; done

# ── portas da verificação livres (nunca derrubar o dono) ─────────────────────
faxina
for porta in 16510 16511 16512 16513 16514; do
  if ss -ltnH "sport = :$porta" | grep -q .; then
    res "ERRO: a porta $porta já está em uso no servidor; não derrubo"; exit 1
  fi
done

# ── árvore do e2e (worktree próprio: o e2e mexe em .env.local, .next, migrations) ──
T0=$(date +%s)
if [ -e "$ARVORE/.git" ]; then
  git -C "$ARVORE" checkout -q -f --detach "$SHA" && git -C "$ARVORE" clean -q -ffdx -e node_modules
else
  rm -rf "$ARVORE"; git -C "$CLONE" worktree prune; git -C "$CLONE" worktree add -q -f --detach "$ARVORE" "$SHA"
fi || { res "ERRO: não pus a árvore do e2e em $SHA"; exit 1; }
for i in $(seq 1 "$PISTAS"); do
  d="$E2E_DIR/pista-$i"
  if [ -e "$d/.git" ]; then
    git -C "$d" checkout -q -f --detach "$SHA" && git -C "$d" clean -q -ffdx
  else
    rm -rf "$d"; git -C "$CLONE" worktree add -q -f --detach "$d" "$SHA"
  fi || { res "ERRO: não pus a pista $i em $SHA"; exit 1; }
done
(cd "$ARVORE" && corepack "pnpm@${VERSAO_PNPM:-9.15.9}" install --frozen-lockfile) > "$LOGS/install.log" 2>&1 \
  || { res "ERRO: pnpm install da árvore do e2e (ver install.log)"; exit 1; }
diz "árvore em $SHA com node_modules ($(( $(date +%s) - T0 ))s)"

# ── imagem da pista: Playwright do repo + socat + psql ───────────────────────
PW="$(node -p 'require(process.argv[1]).version' "$ARVORE/node_modules/@playwright/test/package.json")"
IMG="${PREFIXO}-e2e:pw$PW"
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  diz "montando a imagem $IMG (uma vez por versão do Playwright)"
  printf 'FROM mcr.microsoft.com/playwright:v%s-jammy\nRUN apt-get update && apt-get install -y --no-install-recommends socat postgresql-client && rm -rf /var/lib/apt/lists/*\n' "$PW" \
    | docker build -q -t "$IMG" - > "$LOGS/imagem.log" 2>&1 || { res "ERRO: imagem da pista (ver imagem.log)"; exit 1; }
fi
for im in "$WAHA_IMAGE" "$REDIS_IMAGE" "$SRH_IMAGE"; do
  grep -qw 4 <<<"$TODAS" && { docker image inspect "$im" >/dev/null 2>&1 || docker pull -q "$im" >/dev/null 2>&1 & }
done

# Ferramentas de dentro: o node do servidor (o 22 do CI, não o da imagem), o
# pnpm fixado, e duas réplicas de comando que só respondem o que o e2e pede.
BIN="$E2E_DIR/bin-dentro"; mkdir -p "$BIN"
cmp -s /usr/bin/node "$BIN/node" || cp /usr/bin/node "$BIN/node"
PNPM_CJS="$HOME/.cache/node/corepack/v1/pnpm/${VERSAO_PNPM:-9.15.9}"
[ -f "$PNPM_CJS/bin/pnpm.cjs" ] || { res "ERRO: pnpm ${VERSAO_PNPM:-9.15.9} não está no cache do corepack"; exit 1; }
cat > "$BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
exec node /opt/pnpm/bin/pnpm.cjs "$@"
EOF
# `supabase status` para o gerar-env-e2e.sh: o endereço é o de dentro da pista.
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = status ]; then
  printf 'API_URL="http://127.0.0.1:54321"\nDB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"\nANON_KEY="%s"\nSERVICE_ROLE_KEY="%s"\n' "$SB_ANON" "$SB_SERVICE"
  exit 0
fi
echo "supabase $*: não roda dentro da pista da verificação" >&2; exit 1
EOF
# qa-selo-no-funil-usado faz `docker exec -i supabase_db_deskcomm-crm psql ...`
# (o nome do projeto do config.toml do repo). Aqui ele vira o psql da pista.
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = exec ]; then
  shift; [ "${1:-}" = -i ] && shift
  if [ "${1:-}" = supabase_db_deskcomm-crm ] && [ "${2:-}" = psql ]; then
    shift 2; PGPASSWORD=postgres exec psql -h 127.0.0.1 -p 54322 "$@"
  fi
fi
echo "docker $*: não roda dentro da pista da verificação" >&2; exit 1
EOF
chmod +x "$BIN/pnpm" "$BIN/supabase" "$BIN/docker"
cp "$ESTE" "$BIN/verificar-e2e.sh"

# ── Supabase de uma pista ────────────────────────────────────────────────────
subir_supabase() { # n, log
  local n="$1" log="$2" proj="${PREFIXO}-$1" rede="${PREFIXO}-$1" dir="$E2E_DIR/sb-$1/supabase"
  rm -rf "$E2E_DIR/sb-$n"; mkdir -p "$dir/migrations"
  cp -r "$ARVORE/supabase/templates" "$dir/" 2>/dev/null || true
  sed -E -e "s/^project_id = .*/project_id = \"$proj\"/" \
      -e 's/^port = 54321$/port = 16511/' -e 's/^port = 54322$/port = 16512/' -e 's/^shadow_port = 54320$/shadow_port = 16510/' \
      -e 's/^port = 54323$/port = 16513/' -e 's/^port = 54324$/port = 16514/' -e 's/^port = 54329$/port = 16519/' \
      "$ARVORE/supabase/config.toml" > "$dir/config.toml"
  grep -q "^project_id = \"$proj\"" "$dir/config.toml" || { echo "config.toml sem o project_id da verificação"; return 1; }
  if grep -nE '^(shadow_)?port = 54' "$dir/config.toml"; then echo "porta 54xxx sobrou no config.toml"; return 1; fi
  if ! docker network inspect "$rede" >/dev/null 2>&1; then
    docker network create -o com.docker.network.bridge.host_binding_ipv4="127.0.0.$n" "$rede" >/dev/null || return 1
  fi
  [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' "$rede")" = "127.0.0.$n" ] \
    || { echo "rede $rede sem host_binding 127.0.0.$n"; return 1; }
  local t
  for t in 1 2 3; do
    sb "$n" start -x studio,postgres-meta --network-id "$rede" >> "$log" 2>&1 && break
    echo "supabase start falhou (tentativa $t)"; sb "$n" stop --no-backup >> "$log" 2>&1 || true; sleep $((t * 20))
    [ "$t" = 3 ] && return 1
  done
  if docker ps --filter "label=com.supabase.cli.project=$proj" --format '{{.Ports}}' | grep -Eq '0\.0\.0\.0:|\[::\]:'; then
    echo "algum contêiner de $proj publicou porta fora do loopback"; return 1
  fi
  local db="supabase_db_$proj"
  docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q >> "$log" 2>&1 <<'SQL' || return 1
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
  docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$ARVORE/supabase/baseline.sql" >> "$log" 2>&1 \
    || { echo "baseline falhou"; return 1; }
  docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$(openssl rand -hex 32)') on conflict (name) do nothing;" >> "$log" 2>&1 || return 1
  docker restart "supabase_realtime_$proj" >> "$log" 2>&1 || return 1
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "supabase_realtime_$proj" 2>/dev/null)" = healthy ] && break; sleep 2
  done
  sb "$n" status -o env > "$E2E_DIR/sb-$n/status.env" 2>> "$log" || return 1
}
chave() { grep "^$2=" "$E2E_DIR/sb-$1/status.env" | head -1 | cut -d= -f2- | tr -d '"'; }

# ── contêiner da pista (rede própria; Supabase em 127.0.0.1 por socat) ──────
abrir_conteiner() { # nome, n, dir-montado-em-/w
  local ctr="$1" n="$2" dir="$3" proj="${PREFIXO}-$2"
  docker rm -fv "$ctr" >/dev/null 2>&1 || true
  local extra=()
  # node_modules real da árvore, montado (o Docker criaria o ponto de montagem como root)
  [ "$dir" != "$ARVORE" ] && { mkdir -p "$dir/node_modules"; extra=(-v "$ARVORE/node_modules:/w/node_modules"); }
  docker run -d --init --name "$ctr" --network "${PREFIXO}-$n" --shm-size 2g \
    --user "$(id -u):$(id -g)" -e HOME=/tmp/casa \
    -e SB_ANON="$(chave "$n" ANON_KEY)" -e SB_SERVICE="$(chave "$n" SERVICE_ROLE_KEY)" \
    -v "$dir:/w" "${extra[@]}" -v "$CLONE/.git:$CLONE/.git:ro" \
    -v "$BIN:/verif/bin:ro" -v "$PNPM_CJS:/opt/pnpm:ro" -v "$E2E_DIR/listas:/verif/listas:ro" \
    "$IMG" sleep infinity >/dev/null || return 1
  docker exec -d "$ctr" socat TCP-LISTEN:54321,bind=127.0.0.1,fork,reuseaddr "TCP:supabase_kong_$proj:8000"
  docker exec -d "$ctr" socat TCP-LISTEN:54322,bind=127.0.0.1,fork,reuseaddr "TCP:supabase_db_$proj:5432"
  docker exec -d "$ctr" socat TCP-LISTEN:54324,bind=127.0.0.1,fork,reuseaddr "TCP:supabase_inbucket_$proj:8025"
  docker exec -d "$ctr" socat TCP-LISTEN:8079,bind=127.0.0.1,fork,reuseaddr TCP:127.0.0.1:80
  local _
  for _ in $(seq 1 20); do
    docker exec "$ctr" curl -s -o /dev/null http://127.0.0.1:54321/auth/v1/health && return 0; sleep 1
  done
  echo "o Supabase não respondeu em 127.0.0.1:54321 dentro de $ctr"; return 1
}

# ── build (uma vez, na árvore, pela rede da pista 1) ─────────────────────────
construir() {
  local log="$LOGS/build.log"
  if [ -n "${VERIFICAR_E2E_ESPERAR:-}" ]; then
    diz "build espera o fim do typecheck (memória)"
    while [ ! -f "$VERIFICAR_E2E_ESPERAR" ]; do sleep 5; done
  fi
  local t0; t0=$(date +%s)
  # A chave que vai para o bundle; as pistas comparam com ESTA cópia (o
  # status.env da pista 1 é refeito quando ela troca de parte).
  chave 1 ANON_KEY > "$E2E_DIR/build.chave"
  abrir_conteiner "${PREFIXO}-e2e-build" 1 "$ARVORE" > "$log" 2>&1 \
    && docker exec "${PREFIXO}-e2e-build" bash /verif/bin/verificar-e2e.sh --dentro build >> "$log" 2>&1
  local rc=$?
  docker rm -fv "${PREFIXO}-e2e-build" >/dev/null 2>&1
  echo "$rc $(( $(date +%s) - t0 ))" > "$E2E_DIR/build.fim"
  [ "$rc" = 0 ] && res "build: ok em $(( $(date +%s) - t0 ))s" || res "build: FALHOU (exit $rc, ver build.log)"
  return "$rc"
}

pista() { # n, partes...
  local n="$1"; shift
  local proj="${PREFIXO}-$n" ctr="${PREFIXO}-e2e-pista-$n" dir="$E2E_DIR/pista-$n" primeira=1 p rc t0 slog
  for p in "$@"; do
    t0=$(date +%s); slog="$LOGS/supabase-pista-$n.log"
    [ "$primeira" = 1 ] || sb "$n" stop --no-backup >> "$slog" 2>&1
    if ! subir_supabase "$n" "$slog" >> "$slog" 2>&1; then
      res "parte $p: FALHOU no preparo do Supabase da pista $n (ver $(basename "$slog"))"; echo "parte $p" >> "$E2E_DIR/falhas"
      [ "$n" = 1 ] && [ "$primeira" = 1 ] && echo "1 0" > "$E2E_DIR/build.fim"
      primeira=0; continue
    fi
    if [ "$n" = 1 ] && [ "$primeira" = 1 ]; then construir; fi
    while [ ! -f "$E2E_DIR/build.fim" ]; do sleep 5; done
    if [ "$(cut -d' ' -f1 "$E2E_DIR/build.fim")" != 0 ]; then
      res "parte $p: não rodou (build falhou)"; echo "parte $p" >> "$E2E_DIR/falhas"; primeira=0; continue
    fi
    if [ "$(chave "$n" ANON_KEY)" != "$(cat "$E2E_DIR/build.chave")" ]; then
      res "parte $p: FALHOU — a chave anon da pista $n difere da do build"; echo "parte $p" >> "$E2E_DIR/falhas"; primeira=0; continue
    fi
    primeira=0
    # árvore limpa a cada parte; o build e o .env.e2e (chaves de cifra) vêm da árvore
    git -C "$dir" checkout -q -f --detach "$SHA"; git -C "$dir" clean -q -ffdx -e node_modules
    rm -rf "$dir/.next"; cp -a "$ARVORE/.next" "$dir/.next"; cp "$ARVORE/.env.e2e" "$dir/.env.e2e"
    { abrir_conteiner "$ctr" "$n" "$dir"; } > "$LOGS/parte-$p.log" 2>&1
    if [ "$p" = 4 ]; then
      docker run -d --name "${PREFIXO}-e2e-redis-$n" --network "container:$ctr" "$REDIS_IMAGE" >> "$LOGS/parte-$p.log" 2>&1
      docker run -d --name "${PREFIXO}-e2e-srh-$n" --network "container:$ctr" -e SRH_MODE=env \
        -e SRH_TOKEN=e2e-token-nao-e-segredo -e SRH_CONNECTION_STRING=redis://127.0.0.1:6379 "$SRH_IMAGE" >> "$LOGS/parte-$p.log" 2>&1
      docker run -d --name "${PREFIXO}-e2e-waha-$n" --network "container:$ctr" \
        -e WHATSAPP_HOOK_URL=http://127.0.0.1:3001/api/whatsapp/webhook -e WAHA_NO_API_KEY=True \
        -e WHATSAPP_DEFAULT_ENGINE=NOWEB "$WAHA_IMAGE" >> "$LOGS/parte-$p.log" 2>&1
    fi
    docker exec "$ctr" bash /verif/bin/verificar-e2e.sh --dentro parte "$p" "/verif/listas/parte-$p.txt" >> "$LOGS/parte-$p.log" 2>&1
    rc=$?
    local dur=$(( $(date +%s) - t0 ))
    local rod; rod="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/parte-$p.log" | grep -aE '^ *[0-9]+ (passed|failed|flaky|skipped)' | tr -s ' ' | paste -sd' ' -)"
    if [ "$rc" = 0 ]; then
      res "parte $p: ok em ${dur}s (pista $n; ${rod:-sem rodapé})"
      [ -z "$SPEC" ] && echo "$p $dur" >> "$E2E_DIR/tempos.txt"
    else
      res "parte $p: FALHOU em ${dur}s (exit $rc, pista $n; ${rod:-sem rodapé}; log e2e/parte-$p.log)"
      echo "parte $p" >> "$E2E_DIR/falhas"
      mkdir -p "$LOGS/parte-$p"
      cp -r "$dir/test-results" "$dir/playwright-report" "$LOGS/parte-$p/" 2>/dev/null || true
    fi
    docker rm -fv "$ctr" "${PREFIXO}-e2e-redis-$n" "${PREFIXO}-e2e-srh-$n" "${PREFIXO}-e2e-waha-$n" >/dev/null 2>&1
  done
  sb "$n" stop --no-backup >> "$LOGS/supabase-pista-$n.log" 2>&1
  docker network rm "$proj" >/dev/null 2>&1 || true
}

rm -f "$E2E_DIR/build.fim" "$E2E_DIR/build.chave" "$E2E_DIR/falhas"
for i in $(seq 1 "$PISTAS"); do
  # shellcheck disable=SC2086  # PLANO é a lista de partes, separada por espaço
  ( pista "$i" ${PLANO[$i]} ) 9>&- &
  PIDS+=("$!")
  sleep 3   # não pedir os mesmos pulls de imagem no mesmo segundo
done
wait "${PIDS[@]}"; PIDS=()

if [ -s "$E2E_DIR/falhas" ]; then
  res "e2e: FALHOU ($(sort -u "$E2E_DIR/falhas" | paste -sd, -))"
  exit 1
fi
res "e2e: ok (partes $(paste -sd, <<<"$TODAS"))"
exit 0
