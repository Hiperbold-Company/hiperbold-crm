#!/usr/bin/env bash
# shellcheck disable=SC2015  # o ramo do meio é um echo, que não falha
# Teste do verificar.sh sem servidor: um `ssh` falso no PATH registra o que
# seria executado. Uso: bash hiperbold/scripts/verificar.test.sh
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
  PATH="$TMP/bin:$PATH" bash "$AQUI/verificar.sh" "$@" > "$TMP/out" 2>&1
  local obtido=$?
  if [ "$obtido" = "$esperado" ]; then echo "ok   $desc"; else echo "FAIL $desc (saiu $obtido, esperado $esperado)"; cat "$TMP/out"; falhas=$((falhas+1)); fi
}

bash -n "$AQUI/verificar.sh" && bash -n "$AQUI/verificar-remoto.sh" && echo "ok   sintaxe" || { echo "FAIL sintaxe"; falhas=$((falhas+1)); }

confere "sem branch recusa" 2
confere "opção desconhecida recusa" 2 main --zerar
confere "duas branches recusa" 2 main outra
confere "branch com ; recusa" 2 'main;rm -rf ~'
confere "branch com espaço recusa" 2 'main x'
confere "branch com .. recusa" 2 'a..b'
confere "branch começando com - recusa" 2 -- '-x'
[ ! -s "$SSH_LOG" ] && echo "ok   nada recusado chegou ao ssh" || { echo "FAIL ssh chamado em caso recusado"; falhas=$((falhas+1)); }

confere "branch válida com barra passa" 0 lote/2026-11-19-b --script-local
grep -q 'bash -s -- lote/2026-11-19-b https://github.com/Hiperbold-Company/hiperbold-crm.git' "$SSH_LOG" \
  && echo "ok   checkout recebe a branch e o repositório" || { echo "FAIL checkout sem a branch"; cat "$SSH_LOG"; falhas=$((falhas+1)); }
grep -q 'bash \$HOME/verificacao/\.verificar-remoto\.sh' "$SSH_LOG" \
  && echo "ok   --script-local executa a cópia deste checkout" || { echo "FAIL script local não executado"; cat "$SSH_LOG"; falhas=$((falhas+1)); }
grep -q 'ServerAliveInterval=30' "$SSH_LOG" \
  && echo "ok   ssh com keepalive" || { echo "FAIL ssh sem keepalive"; falhas=$((falhas+1)); }

confere "sem --script-local usa o script da branch" 0 main
grep -q 'bash \$HOME/verificacao/hiperbold-crm/hiperbold/scripts/verificar-remoto\.sh' "$SSH_LOG" \
  && echo "ok   script da branch executado" || { echo "FAIL script da branch não executado"; cat "$SSH_LOG"; falhas=$((falhas+1)); }

bash "$AQUI/verificar-remoto.sh" --apagar > /dev/null 2>&1
[ $? = 2 ] && echo "ok   parte remota recusa argumento desconhecido" || { echo "FAIL parte remota aceitou argumento"; falhas=$((falhas+1)); }

echo "falhas: $falhas"
[ "$falhas" = 0 ]
