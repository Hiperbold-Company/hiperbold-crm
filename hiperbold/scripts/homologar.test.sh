#!/usr/bin/env bash
# shellcheck disable=SC2015  # o ramo do meio é um echo, que não falha
# Teste do homologar.sh sem servidor: um `ssh` falso no PATH registra o que
# seria executado. Uso: bash hiperbold/scripts/homologar.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SSH_LOG"
cat > /dev/null
exit 0
EOF
chmod +x "$TMP/bin/ssh"
export SSH_LOG="$TMP/ssh.log"

falhas=0
confere() { # descrição, código esperado, args...
  local desc="$1" esperado="$2"; shift 2
  : > "$SSH_LOG"
  PATH="$TMP/bin:$PATH" bash "$AQUI/homologar.sh" "$@" > "$TMP/out" 2>&1
  local obtido=$?
  if [ "$obtido" = "$esperado" ]; then echo "ok   $desc"; else echo "FAIL $desc (saiu $obtido, esperado $esperado)"; cat "$TMP/out"; falhas=$((falhas+1)); fi
}

bash -n "$AQUI/homologar.sh" && bash -n "$AQUI/homologar-remoto.sh" && echo "ok   sintaxe" || { echo "FAIL sintaxe"; falhas=$((falhas+1)); }

confere "sem branch recusa" 2
confere "opção desconhecida recusa" 2 main --apagar-tudo
confere "duas branches recusa" 2 main outra
confere "branch com ; recusa" 2 'main;rm -rf ~'
confere "branch com espaço recusa" 2 'main x'
confere "branch com .. recusa" 2 'a..b'
confere "branch começando com - recusa" 2 -- '-x'
HOMOLOG_PORTA_WEB='3490;id' confere "porta de teste inválida recusa" 2 main
[ ! -s "$SSH_LOG" ] && echo "ok   nada recusado chegou ao ssh" || { echo "FAIL ssh chamado em caso recusado"; falhas=$((falhas+1)); }

confere "branch válida com barra passa" 0 feat/homologar --zerar --script-local
grep -q 'bash -s -- feat/homologar' "$SSH_LOG" && echo "ok   checkout recebe a branch" || { echo "FAIL checkout sem a branch"; falhas=$((falhas+1)); }
grep -q '\.homologar-remoto\.sh --zerar' "$SSH_LOG" && echo "ok   --zerar chega à parte remota" || { echo "FAIL --zerar não repassado"; cat "$SSH_LOG"; falhas=$((falhas+1)); }

HOMOLOG_PORTA_WEB=3490 confere "porta de teste válida passa" 0 main --script-local
grep -q 'HOMOLOG_PORTA_WEB=3490 bash' "$SSH_LOG" && echo "ok   porta de teste repassada" || { echo "FAIL porta não repassada"; falhas=$((falhas+1)); }

echo "falhas: $falhas"
[ "$falhas" = 0 ]
