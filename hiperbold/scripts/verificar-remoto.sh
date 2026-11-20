#!/usr/bin/env bash
# Parte remota do `verificar`: roda NO servidor hiperbold-homolog (WSL), depois
# que o verificar.sh do Mac já pôs o clone da verificação na branch pedida.
#
# Roda os testes pesados do CI do GitHub, na ordem:
#   install    pnpm install --frozen-lockfile (o pnpm da versão de packageManager)
#   typecheck  pnpm typecheck (NODE_OPTIONS=--max-old-space-size=8192)
#   lint       pnpm lint
#   unit       pnpm test:unit (a suíte inteira, sem recorte)
#   db         pnpm test:db (Postgres efêmero próprio em 127.0.0.1:16500)
# Falha no install pula o resto; as outras etapas rodam todas, mesmo com uma
# vermelha antes, para o resultado dizer tudo o que falhou.
#
# Cada etapa vale pelo EXIT CODE (CLAUDE.md, seção Testes), nunca pelo rodapé.
# Logs em ~/verificacao/logs/<sha>/<etapa>.log e resumo.txt. No fim publica o
# status `verificar/wsl` (success/failure) no commit, pelo gh já autenticado.
#
# E2E: NÃO roda. O e2e.yml usa portas fixas que neste servidor já têm dono:
# o Supabase do config.toml do repo publica 54320-54329 (54321-54323 estão
# ocupadas por containers antigos do Windows, e o project_id deskcomm-crm é o
# Supabase antigo daqui; um `supabase start` do clone mexeria nele), o WAHA na
# 3000 (prévia antiga no túnel), além de 3001, 3995-3999 e 8079 cravadas nos
# passos e no .env.e2e. Rodar exigiria remapear tudo isso no workflow, que não
# é desta ferramenta. A porta 3590 fica reservada para quando houver.
#
# Uso: verificar-remoto.sh
set -uo pipefail

VERIF_DIR="${VERIFICAR_DIR:-$HOME/verificacao}"
CLONE="${VERIFICAR_CLONE:-$VERIF_DIR/hiperbold-crm}"
REPO_GH="Hiperbold-Company/hiperbold-crm"
CONTEXTO="verificar/wsl"
# Portas da verificação = as da prévia do CRM + 100 (~/.claude/regras/hiperbold-homolog.md).
PORTA_DB=16500     # Postgres efêmero do test:db (só 127.0.0.1)
export VERIFICAR_PORTA_WEB=3590  # reservada para o e2e; sem uso enquanto ele não roda

case "${1:-}" in
  -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  "") ;;
  *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
esac

exec 9>"$VERIF_DIR/.verificar.lock"
flock -n 9 || { echo "ERRO: outra rodada do verificar está em andamento" >&2; exit 4; }

[ -d "$CLONE/.git" ] || { echo "ERRO: clone não encontrado em $CLONE" >&2; exit 1; }
cd "$CLONE"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"   # completo: a API de statuses não aceita o curto
LOGS="$VERIF_DIR/logs/$SHA"
mkdir -p "$LOGS"
RESUMO="$LOGS/resumo.txt"
: > "$RESUMO"
INICIO=$(date +%s)

info() { printf '%s\n' "$*" | tee -a "$RESUMO"; }

PUBLICADO=0
publicar() { # estado, descrição
  local estado="$1" desc="$2"
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
# Morreu antes do fim (sinal, erro inesperado): o commit não fica sem resposta.
trap '[ "$PUBLICADO" = 1 ] || publicar failure "verificar interrompido antes do fim (ver ~/verificacao/logs/${SHA:0:10})"' EXIT

info "verificar: $BRANCH @ $SHA"
info "logs: $LOGS"

# Porta do banco tem de estar livre: nunca derrubar o dono.
if ss -ltn "sport = :$PORTA_DB" | grep -q LISTEN; then
  info "ERRO: a porta $PORTA_DB já está em uso por outro processo; não derrubo"
  publicar failure "porta $PORTA_DB ocupada no servidor; nada rodou"
  exit 1
fi

# O pnpm fixado em packageManager, nunca o global do servidor (pnpm 11 trata
# lockfile e scripts de build de outro jeito e daria vermelho falso).
VERSAO_PNPM="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' package.json | head -1)"
[ -n "$VERSAO_PNPM" ] || { info "ERRO: package.json sem packageManager pnpm@"; publicar failure "package.json sem packageManager"; exit 1; }
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PNPM=(corepack "pnpm@$VERSAO_PNPM")
info "pnpm: $("${PNPM[@]}" --version 2>&1 | tail -1) (fixado $VERSAO_PNPM); node: $(node -v)"
# O pnpm dos scripts (test:db chama vitest pelo PATH do pnpm) tem de ser o mesmo.
mkdir -p "$VERIF_DIR/bin"
cat > "$VERIF_DIR/bin/pnpm" <<EOF
#!/usr/bin/env bash
exec corepack pnpm@$VERSAO_PNPM "\$@"
EOF
chmod +x "$VERIF_DIR/bin/pnpm"
export PATH="$VERIF_DIR/bin:$PATH"
export CI=true

FALHAS=()
TEMPOS=()
etapa() { # nome, comando...
  local nome="$1"; shift
  local t0 rc dur
  t0=$(date +%s)
  echo "== $nome ..."
  "$@" > "$LOGS/$nome.log" 2>&1
  rc=$?
  dur=$(( $(date +%s) - t0 ))
  TEMPOS+=("$nome=${dur}s")
  if [ "$rc" = 0 ]; then
    info "$nome: ok em ${dur}s"
  else
    info "$nome: FALHOU em ${dur}s (exit $rc, log $LOGS/$nome.log)"
    FALHAS+=("$nome")
  fi
  return "$rc"
}

if etapa install pnpm install --frozen-lockfile; then
  etapa typecheck env NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
  etapa lint pnpm lint
  etapa unit pnpm test:unit
  # GH_TOKEN como no CI (o test:db consulta a última release); nunca vai para o log.
  etapa db env TEST_DB_PORT="$PORTA_DB" GH_TOKEN="$(gh auth token 2>/dev/null)" pnpm test:db
else
  info "install falhou: typecheck, lint, unit e db não rodaram"
fi

# Primeira linha de erro de cada etapa vermelha, para o resumo.
for f in "${FALHAS[@]}"; do
  primeira="$(grep -aE -m1 'FAIL |error|Error|ERRO|ERR_' "$LOGS/$f.log" | cut -c1-200)"
  info "   $f: ${primeira:-sem linha de erro reconhecível; ver o log}"
done

TOTAL=$(( $(date +%s) - INICIO ))
info "tempos: ${TEMPOS[*]} total=${TOTAL}s"
info "e2e: não roda nesta ferramenta (portas fixas do e2e.yml ocupadas no servidor)"

if [ "${#FALHAS[@]}" = 0 ]; then
  publicar success "install, typecheck, lint, unit e db ok em $((TOTAL / 60))min; e2e não roda aqui"
  exit 0
else
  publicar failure "falhou: ${FALHAS[*]} ($((TOTAL / 60))min); e2e não roda aqui"
  exit 1
fi
