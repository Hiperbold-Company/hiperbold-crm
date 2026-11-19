#!/usr/bin/env bash
# Parte remota do `homologar`: roda NO servidor hiperbold-homolog (WSL), depois
# que o homologar.sh do Mac já pôs o clone da homologação na branch pedida.
#
# Monta a homologação inteira com dados de exemplo, nunca com dado de produção:
#   1. Supabase local próprio (CLI, project_id hiperbold-homolog, portas 5532x,
#      só em 127.0.0.1) com o schema do kit self-host: supabase/baseline.sql.
#      Banco novo: install (ON_ERROR_STOP=1). Banco existente: update (reaplica
#      sem a flag, como o update.sh), sem apagar dados.
#   2. Dados de exemplo da "Clínica Demonstração" (scripts/demo-site/02 e 03) e
#      o dono pelo scripts/bootstrap-owner.ts, como o install.sh faz.
#   3. app + worker + scheduler + Redis/SRH construídos AQUI a partir do clone,
#      atrás de um Caddy em 127.0.0.1:3400 que serve app e APIs do Supabase na
#      mesma origem (como o Caddyfile.single-server).
#
# Tudo o que é gerado mora em ~/homologacao, fora do clone (o reset --hard do
# clone não leva nada): .env.homolog (segredos de teste, 600), credenciais.txt
# (600), runtime/ (compose, Caddyfile, env do app), supabase/ (workdir da CLI),
# logs/.
#
# Uso: homologar-remoto.sh [--zerar]
#   --zerar  apaga o banco da homologação e recria do zero (só o projeto
#            hiperbold-homolog; nada de outro projeto é tocado).
set -Eeuo pipefail

HOMOLOG_DIR="${HOMOLOG_DIR:-$HOME/homologacao}"
CLONE="${HOMOLOG_CLONE:-$HOMOLOG_DIR/hiperbold-crm}"
ENV_HOMOLOG="$HOMOLOG_DIR/.env.homolog"
CREDENCIAIS="$HOMOLOG_DIR/credenciais.txt"
RUNTIME="$HOMOLOG_DIR/runtime"
SB_WORKDIR="$HOMOLOG_DIR/supabase"
LOGS="$HOMOLOG_DIR/logs"

PROJETO="hiperbold-homolog"          # project_id da CLI, nome do compose e da rede
REDE="hiperbold-homolog"
SB_CLI="npx --yes supabase@2.117.0"  # a mesma versão que os scripts do repo usam
# Portas fixas da prévia do CRM (~/.claude/regras/hiperbold-homolog.md):
# app 3400 e banco 16400. 3500 e 16500 ficam reservadas, não usar.
# HOMOLOG_PORTA_WEB existe só para teste quando a 3400 estiver ocupada.
PORTA_WEB="${HOMOLOG_PORTA_WEB:-3400}"
PORTA_DB=16400                        # Postgres do Supabase (só 127.0.0.1)
PORTA_API=55321                       # Kong do Supabase (só 127.0.0.1)
PORTA_SHADOW=55320
DB_CTR="supabase_db_${PROJETO}"
KONG_CTR="supabase_kong_${PROJETO}"
EMAIL_DONO="juliana.ferraz@exemplo.com.br"   # a dona da Clínica Demonstração
ORG_DEMO="demo-site-2026"

ZERAR=0
for arg in "$@"; do
  case "$arg" in
    --zerar) ZERAR=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$HOMOLOG_DIR" "$RUNTIME" "$SB_WORKDIR/supabase" "$LOGS"
chmod 700 "$HOMOLOG_DIR"
LOG="$LOGS/$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
INICIO=$(date +%s)

passo() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
info()  { printf '   %s\n' "$*" | tee -a "$LOG"; }
falha() { printf 'ERRO: %s\n   log: %s\n' "$*" "$LOG" >&2; exit 1; }
trap 'falha "parou na linha $LINENO (comando: $BASH_COMMAND)"' ERR

# Uma rodada por vez: duas ao mesmo tempo disputariam o mesmo banco e as imagens.
exec 9>"$HOMOLOG_DIR/.homologar.lock"
flock -n 9 || falha "outra rodada do homologar está em andamento"

[ -d "$CLONE/.git" ] || falha "clone não encontrado em $CLONE"
[ -f "$CLONE/supabase/baseline.sql" ] || falha "a branch não tem supabase/baseline.sql"
BRANCH="$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
COMMIT="$(git -C "$CLONE" rev-parse --short=10 HEAD)"

# ── 1. Segredos de teste (gerados uma vez, nunca copiados de outro lugar) ────
passo "segredos de teste ($ENV_HOMOLOG)"
umask 077
if [ ! -s "$ENV_HOMOLOG" ]; then
  h() { openssl rand -hex 32; }
  b() { openssl rand -base64 32; }
  senha() { local p; p="$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 4096 /dev/urandom))"; printf '%s' "${p:0:24}"; }
  WK="$(h)"; SRH="$(h)"
  cat > "$ENV_HOMOLOG" <<EOF
# Homologação do Hiperbold CRM: só valores de TESTE gerados aqui. Nunca colar em chat.
# Endereço que o NAVEGADOR usa (app e APIs do Supabase na mesma origem).
# Vazio = http://127.0.0.1:<porta da prévia>. Quando o túnel publicar, ponha
# https://previa-crm.hiperbold.com.br e rode o homologar de novo.
HOMOLOG_ORIGEM=
HOMOLOG_JWT_SECRET=$(h)
HOMOLOG_SENHA_DONO=$(senha)
HOMOLOG_SENHA_EQUIPE=$(senha)
INTERNAL_SECRET=$(h)
CPF_ENCRYPTION_KEY=$(b)
AI_CRED_AES_KEY=$(b)
WAHA_BYO_ENCRYPTION_KEY=$(b)
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=$(h)
IMPERSONATE_COOKIE_SECRET=$(h)
LGPD_SIGNING_KEY=$(h)
WAHA_API_KEY=${WK}
WAHA_API_KEY_SHA512=$(printf %s "$WK" | sha512sum | cut -d' ' -f1)
WAHA_HMAC_SECRET=$(h)
SRH_TOKEN=${SRH}
EOF
  info "gerado agora"
else
  info "já existia, reaproveitado"
fi
chmod 600 "$ENV_HOMOLOG"
set -a
# shellcheck disable=SC1090
. "$ENV_HOMOLOG"
set +a
ORIGEM="${HOMOLOG_ORIGEM:-http://127.0.0.1:$PORTA_WEB}"
ORIGEM="${ORIGEM%/}"

# A porta da prévia tem de estar livre ou ser do próprio Caddy da homologação.
# Nunca derrubar o que estiver nela: é de outro projeto.
porta_ocupada_por_outro() {
  local porta="$1" dono
  ss -ltn "sport = :$porta" | grep -q LISTEN || return 1
  dono="$(docker ps --filter "publish=$porta" --format '{{.Names}}' | head -1)"
  [ -n "$dono" ] && [[ "$dono" == "${PROJETO}-"* || "$dono" == *"_${PROJETO}" ]] && return 1
  return 0
}
for porta in "$PORTA_WEB" "$PORTA_DB" "$PORTA_API"; do
  if porta_ocupada_por_outro "$porta"; then
    falha "a porta $porta já está em uso por outro processo ($(ss -ltnp "sport = :$porta" 2>/dev/null | grep -o 'users:.*' | head -1)); não derrubo"
  fi
done

# ── 2. Supabase local da homologação ─────────────────────────────────────────
passo "Supabase local ($PROJETO, API 127.0.0.1:$PORTA_API, banco 127.0.0.1:$PORTA_DB)"
# A rede com host_binding 127.0.0.1 é o que faz a CLI (que não tem opção de
# endereço) publicar as portas só no loopback do WSL.
if ! docker network inspect "$REDE" >/dev/null 2>&1; then
  docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$REDE" >>"$LOG"
fi
[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' "$REDE")" = "127.0.0.1" ] \
  || falha "a rede $REDE existe sem host_binding 127.0.0.1; não subo nada nela"

# Workdir próprio, fora do clone: o config.toml do repo é do projeto
# deskcomm-crm (o Supabase antigo deste servidor), e um start/stop a partir
# dele mexeria no projeto errado. Sem pasta migrations: o schema é o baseline.
CONFIG="$SB_WORKDIR/supabase/config.toml"
CONFIG_ANTERIOR="$(cat "$CONFIG" 2>/dev/null || true)"
cat > "$CONFIG" <<EOF
# Gerado pelo homologar-remoto.sh. Não editar à mão.
project_id = "$PROJETO"

[api]
enabled = true
port = $PORTA_API
schemas = ["public", "storage", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = $PORTA_DB
shadow_port = $PORTA_SHADOW
major_version = 15

[db.pooler]
enabled = false

[realtime]
enabled = true

[studio]
enabled = false

[inbucket]
enabled = false

[storage]
enabled = true
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "$ORIGEM"
additional_redirect_urls = ["$ORIGEM/auth/callback", "$ORIGEM/auth/confirm"]
jwt_expiry = 3600
jwt_secret = "env(HOMOLOG_JWT_SECRET)"
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10
enable_signup = true

[auth.email]
enable_signup = true
double_confirm_changes = true
enable_confirmations = false

[auth.mfa]
max_enrolled_factors = 10

[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true

[edge_runtime]
enabled = false

[analytics]
enabled = false
EOF

sb() { (cd "$SB_WORKDIR" && $SB_CLI "$@" --workdir "$SB_WORKDIR"); }

if [ "$ZERAR" = 1 ]; then
  info "--zerar: apagando o banco do projeto $PROJETO (só ele)"
  sb stop --no-backup >>"$LOG" 2>&1 || true
fi
if docker ps --format '{{.Names}}' | grep -qx "$DB_CTR" && [ "$CONFIG_ANTERIOR" != "$(cat "$CONFIG")" ]; then
  # O Auth só lê site_url e redirects no start: origem ou porta mudou, reinicia
  # (stop sem --no-backup guarda os dados).
  info "configuração mudou (origem ou porta): reiniciando o Supabase, dados mantidos"
  sb stop >>"$LOG" 2>&1 || falha "supabase stop falhou"
fi
if docker ps --format '{{.Names}}' | grep -qx "$DB_CTR"; then
  info "já estava de pé"
else
  sb start --network-id "$REDE" >>"$LOG" 2>&1 || falha "supabase start falhou"
fi

STATUS_ENV="$(sb status -o env 2>>"$LOG")"
sval() { printf '%s\n' "$STATUS_ENV" | grep -E "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }
ANON_KEY="$(sval ANON_KEY)"
SERVICE_ROLE_KEY="$(sval SERVICE_ROLE_KEY)"
[ -n "$ANON_KEY" ] && [ -n "$SERVICE_ROLE_KEY" ] || falha "supabase status não devolveu as chaves"

# Nenhuma porta do projeto pode ter ficado fora do loopback.
if docker ps --filter "name=_${PROJETO}" --format '{{.Ports}}' | grep -Eq '0\.0\.0\.0:|\[::\]:'; then
  falha "algum container do $PROJETO publicou porta fora de 127.0.0.1"
fi

psqlc() { docker exec -i "$DB_CTR" psql -U postgres -d postgres -q "$@"; }

# ── 3. Schema: baseline.sql como o kit self-host aplica ──────────────────────
if [ "$(psqlc -tAc "select to_regclass('public.organizations') is not null")" = "t" ]; then
  MODO=update
else
  MODO=install
fi
passo "schema: supabase/baseline.sql (modo $MODO)"
psqlc -v ON_ERROR_STOP=1 >>"$LOG" 2>&1 <<'SQL'
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
if [ "$MODO" = install ]; then
  psqlc -v ON_ERROR_STOP=1 < "$CLONE/supabase/baseline.sql" >>"$LOG" 2>&1 \
    || falha "baseline em modo install falhou"
  info "instalado do zero"
else
  # Como o update.sh: reaplica sem ON_ERROR_STOP. O apêndice é idempotente; o
  # que já existe reclama e segue.
  # Sem ON_ERROR_STOP o psql só sai com erro quando nem consegue rodar.
  psqlc < "$CLONE/supabase/baseline.sql" > "$LOGS/baseline-update.log" 2>&1 \
    || falha "baseline em modo update não rodou (ver $LOGS/baseline-update.log)"
  info "reaplicado; $(grep -c 'ERROR' "$LOGS/baseline-update.log" || true) linhas de ERROR (esperado em update; detalhe em $LOGS/baseline-update.log)"
fi
# Realtime e PostgREST só enxergam publication e schema novos depois de reiniciar.
docker restart "supabase_realtime_${PROJETO}" "supabase_rest_${PROJETO}" >>"$LOG"

# A chave de cifra dos segredos (D-021). Nunca troca uma que o banco já tem.
estado_chave="$(psqlc -tA -v chave="$NUVEMSHOP_OAUTH_ENCRYPTION_KEY" <<'SQL'
select case
  when not exists (select 1 from private.app_secrets where name = 'nuvemshop_oauth_key') then 'ausente'
  when (select value from private.app_secrets where name = 'nuvemshop_oauth_key') = :'chave' then 'igual'
  else 'diferente' end;
SQL
)"
case "$estado_chave" in
  ausente) psqlc -v ON_ERROR_STOP=1 -v chave="$NUVEMSHOP_OAUTH_ENCRYPTION_KEY" >>"$LOG" <<'SQL'
insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', :'chave') on conflict (name) do nothing;
SQL
    info "chave de cifra semeada" ;;
  igual) info "chave de cifra já semeada" ;;
  *) falha "o banco tem outra chave de cifra (estado: $estado_chave); use --zerar ou alinhe o .env.homolog" ;;
esac

# ── 4. Arquivos de execução (fora do clone) ──────────────────────────────────
passo "arquivos de execução ($RUNTIME)"
cat > "$RUNTIME/app.env" <<EOF
# Gerado pelo homologar-remoto.sh a cada rodada, a partir do .env.homolog.
NODE_ENV=production
APP_NAME=Hiperbold CRM
NEXT_PUBLIC_SUPABASE_URL=$ORIGEM
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
SUPABASE_SERVER_URL=http://$KONG_CTR:8000
SUPABASE_DB_URL=postgresql://postgres:postgres@$DB_CTR:5432/postgres
SUPABASE_DB_ADMIN_URL=postgresql://postgres:postgres@$DB_CTR:5432/postgres
NEXT_PUBLIC_APP_URL=$ORIGEM
NEXT_PUBLIC_ADMIN_URL=$ORIGEM
INTERNAL_SECRET=$INTERNAL_SECRET
CPF_ENCRYPTION_KEY=$CPF_ENCRYPTION_KEY
AI_CRED_AES_KEY=$AI_CRED_AES_KEY
WAHA_BYO_ENCRYPTION_KEY=$WAHA_BYO_ENCRYPTION_KEY
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=$NUVEMSHOP_OAUTH_ENCRYPTION_KEY
NUVEMSHOP_ENABLED=false
IMPERSONATE_COOKIE_SECRET=$IMPERSONATE_COOKIE_SECRET
LGPD_SIGNING_KEY=$LGPD_SIGNING_KEY
WAHA_API_BASE_URL=http://waha:3000
WAHA_WEBHOOK_BASE_URL=http://app:3000
WAHA_API_KEY=$WAHA_API_KEY
WAHA_API_KEY_SHA512=$WAHA_API_KEY_SHA512
WAHA_HMAC_SECRET=$WAHA_HMAC_SECRET
UPSTASH_REDIS_REST_URL=http://srh:80
UPSTASH_REDIS_REST_TOKEN=$SRH_TOKEN
EVENT_LOG_WORKER_DRAINS=true
SENTRY_DSN=
EOF
chmod 600 "$RUNTIME/app.env"

cat > "$RUNTIME/Caddyfile" <<EOF
# Gerado pelo homologar-remoto.sh. Mesma origem para app e APIs do Supabase,
# como o Caddyfile.single-server do repo.
{
	admin off
	auto_https off
}

:80 {
	encode gzip
	route {
		@waha_global path /api/v1/webhooks/waha
		respond @waha_global 403

		@supabase path /auth/v1* /rest/v1* /realtime/v1* /storage/v1* /graphql/v1*
		reverse_proxy @supabase $KONG_CTR:8000

		reverse_proxy app:3000
	}
}
EOF

cat > "$RUNTIME/compose.yml" <<EOF
# Gerado pelo homologar-remoto.sh. Projeto $PROJETO; só o Caddy publica porta,
# e só em 127.0.0.1. As imagens são construídas antes, uma a uma (pull_policy never).
name: $PROJETO

services:
  app:
    image: $PROJETO-app:latest
    pull_policy: never
    restart: unless-stopped
    env_file: $RUNTIME/app.env
    depends_on:
      srh:
        condition: service_started
    healthcheck:
      test: ["CMD", "node", "-e", "require('net').connect(3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 30s

  worker:
    image: $PROJETO-worker:latest
    pull_policy: never
    restart: unless-stopped
    env_file: $RUNTIME/app.env

  scheduler:
    image: $PROJETO-scheduler:latest
    pull_policy: never
    restart: unless-stopped
    environment:
      TZ: UTC
      INTERNAL_SECRET: \${INTERNAL_SECRET}
    depends_on:
      app:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]

  srh:
    image: hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150
    restart: unless-stopped
    environment:
      SRH_MODE: env
      SRH_TOKEN: \${SRH_TOKEN}
      SRH_CONNECTION_STRING: redis://redis:6379
    depends_on:
      - redis

  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:$PORTA_WEB:80"
    volumes:
      - $RUNTIME/Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on:
      - app

networks:
  default:
    name: $REDE
    external: true
EOF
COMPOSE=(docker compose -f "$RUNTIME/compose.yml" --env-file "$ENV_HOMOLOG")

# ── 5. Imagens (construídas aqui, a partir do clone) ─────────────────────────
passo "construindo imagens de $BRANCH @ $COMMIT (saída no log)"
t0=$(date +%s)
# A imagem de ferramentas é o estágio `build` do Dockerfile: mesmo cache da
# imagem do app, com node_modules e tsx para rodar o bootstrap-owner.ts.
DOCKER_BUILDKIT=1 docker build --target build -t "$PROJETO-ferramentas:latest" "$CLONE" >>"$LOG" 2>&1 \
  || falha "build da imagem de ferramentas falhou"
# Uma imagem de cada vez: o build paralelo do compose derrubou o frontend do
# BuildKit nesta máquina ("frontend grpc server closed unexpectedly").
construir() { # nome, Dockerfile, args extras
  local nome="$1" df="$2"; shift 2
  DOCKER_BUILDKIT=1 docker build -f "$CLONE/$df" -t "$PROJETO-$nome:latest" \
    --build-arg APP_VERSION="homolog-$COMMIT" "$@" "$CLONE" >>"$LOG" 2>&1 \
    || falha "build da imagem $nome falhou"
}
construir app Dockerfile --build-arg APP_COMMIT="$COMMIT"
construir worker Dockerfile.worker
construir scheduler Dockerfile.scheduler
info "imagens prontas em $(( $(date +%s) - t0 ))s"

# ── 6. Dados de exemplo e dono ───────────────────────────────────────────────
passo "dados de exemplo (Clínica Demonstração) e dono"
API="http://127.0.0.1:$PORTA_API"
criar_usuario() {
  local email="$1" nome="$2" agora codigo
  if [ "$(psqlc -tAc "select count(*) from auth.users where email = '$email'")" != "0" ]; then
    return 0
  fi
  agora="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/auth/v1/admin/users" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    --data-binary @- <<JSON
{"email":"$email","password":"$HOMOLOG_SENHA_EQUIPE","email_confirm":true,
 "app_metadata":{"email_verificado_em":"$agora"},
 "user_metadata":{"name":"$nome","full_name":"$nome","locale":"pt-BR"}}
JSON
)"
  [ "$codigo" = 200 ] || falha "criar usuário $email respondeu $codigo"
  info "usuário criado: $email"
}
criar_usuario "$EMAIL_DONO" "Juliana Ferraz"
criar_usuario ricardo.almeida@exemplo.com.br "Ricardo Almeida"
criar_usuario beatriz.santos@exemplo.com.br "Beatriz Santos"
criar_usuario lucas.moreira@exemplo.com.br "Lucas Moreira"

# Os dois roteiros só criam o que falta (recusam se a org ou os negócios já existem).
for f in 02-org.sql 03-dados.sql; do
  [ -f "$CLONE/scripts/demo-site/$f" ] || falha "a branch não tem scripts/demo-site/$f"
  psqlc -v ON_ERROR_STOP=1 < "$CLONE/scripts/demo-site/$f" >>"$LOG" 2>&1 || falha "dados de exemplo ($f) falharam"
done

# O dono pelo mesmo bootstrap do install.sh: o slug da org de exemplo coincide
# com o slugify do nome, então ele a encontra e não cria outra.
docker run --rm --network "$REDE" --env-file "$RUNTIME/app.env" \
  -e NEXT_PUBLIC_SUPABASE_URL="http://$KONG_CTR:8000" \
  -e OWNER_EMAIL="$EMAIL_DONO" -e OWNER_PASSWORD="$HOMOLOG_SENHA_DONO" -e OWNER_ORG_NAME="$ORG_DEMO" \
  "$PROJETO-ferramentas:latest" npx tsx scripts/bootstrap-owner.ts >>"$LOG" 2>&1 \
  || falha "bootstrap-owner.ts falhou"
info "dono garantido: $EMAIL_DONO (admin da org e super-admin)"

# ── 7. Sobe a aplicação ──────────────────────────────────────────────────────
passo "subindo app, worker, scheduler, Redis e Caddy"
"${COMPOSE[@]}" up -d --remove-orphans >>"$LOG" 2>&1 || falha "compose up falhou"
codigo=000
for _ in $(seq 1 60); do
  codigo="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA_WEB/login" || true)"
  [ "$codigo" = 200 ] && break
  sleep 3
done
[ "$codigo" = 200 ] || falha "/login não respondeu 200 (último: $codigo)"

# ── 8. Credenciais e resumo ──────────────────────────────────────────────────
cat > "$CREDENCIAIS" <<EOF
# Homologação do Hiperbold CRM. Só contas de teste. Não colar em chat.
Endereço: $ORIGEM  (no WSL: http://127.0.0.1:$PORTA_WEB)
Dono (admin da Clínica Demonstração e super-admin):
  e-mail: $EMAIL_DONO
  senha:  $HOMOLOG_SENHA_DONO
Equipe (mesma senha): ricardo.almeida@exemplo.com.br (gerente),
  beatriz.santos@exemplo.com.br e lucas.moreira@exemplo.com.br (atendentes)
  senha:  $HOMOLOG_SENHA_EQUIPE
EOF
chmod 600 "$CREDENCIAIS"

saude="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA_WEB/api/v1/health" || true)"
contagem="$(psqlc -tA -F ' | ' -c "select
  (select count(*) from public.crm_leads)     as negocios,
  (select count(*) from public.contacts)      as contatos,
  (select count(*) from public.conversations) as conversas,
  (select count(*) from public.messages)      as mensagens")"

passo "pronto em $(( $(date +%s) - INICIO ))s"
info "branch:      $BRANCH"
info "commit:      $COMMIT"
info "endereço:    $ORIGEM  (no WSL: http://127.0.0.1:$PORTA_WEB)"
info "/login:      200   /api/v1/health: $saude"
info "dados:       negócios | contatos | conversas | mensagens = $contagem"
info "dono:        $EMAIL_DONO (senha em $CREDENCIAIS)"
info "credenciais: $CREDENCIAIS"
info "log:         $LOG"
