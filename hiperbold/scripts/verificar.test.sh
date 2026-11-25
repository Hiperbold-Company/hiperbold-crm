#!/usr/bin/env bash
# shellcheck disable=SC2015  # o ramo do meio é um echo, que não falha
# Teste do verificar.sh sem servidor: um `ssh` falso no PATH registra o que
# seria executado e responde como o servidor (pasta da rodada no disparo,
# resumo e __FIM__ no acompanhamento). Uso: bash hiperbold/scripts/verificar.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/bin/* "$TMP"/ssh.log "$TMP"/out; rmdir "$TMP/bin" "$TMP" 2>/dev/null' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SSH_LOG"
cat > /dev/null
case "$*" in
  *"setsid nohup"*) echo /fake/logs/rodada ;;
  *__LINHAS__*) echo "install: ok em 1s"; echo "__LINHAS__ 1"; echo "__FIM__ ${FIM_RC:-0}" ;;
  *"readlink -f"*) echo /fake/logs/ultima-rodada ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/ssh"
export SSH_LOG="$TMP/ssh.log" VERIFICAR_INTERVALO=0

falhas=0
confere() { # descrição, código esperado, args...
  local desc="$1" esperado="$2"; shift 2
  : > "$SSH_LOG"
  PATH="$TMP/bin:$PATH" bash "$AQUI/verificar.sh" "$@" > "$TMP/out" 2>&1
  local obtido=$?
  if [ "$obtido" = "$esperado" ]; then echo "ok   $desc"; else echo "FAIL $desc (saiu $obtido, esperado $esperado)"; cat "$TMP/out"; falhas=$((falhas+1)); fi
}
tem() { # descrição, padrão (grep -E) no log do ssh
  grep -qE -- "$2" "$SSH_LOG" && echo "ok   $1" || { echo "FAIL $1"; cat "$SSH_LOG"; falhas=$((falhas+1)); }
}
nao_tem() {
  grep -qE -- "$2" "$SSH_LOG" && { echo "FAIL $1"; cat "$SSH_LOG"; falhas=$((falhas+1)); } || echo "ok   $1"
}

for s in verificar.sh verificar-remoto.sh verificar-e2e.sh; do
  bash -n "$AQUI/$s" && echo "ok   sintaxe $s" || { echo "FAIL sintaxe $s"; falhas=$((falhas+1)); }
done

confere "sem branch recusa" 2
confere "opção desconhecida recusa" 2 main --zerar
confere "duas branches recusa" 2 main outra
confere "branch com ; recusa" 2 'main;rm -rf ~'
confere "branch com espaço recusa" 2 'main x'
confere "branch com .. recusa" 2 'a..b'
confere "branch começando com - recusa" 2 -- '-x'
confere "--so sem alvo recusa" 2 main --so
confere "--so com ; recusa" 2 main --so 'tests/x.test.ts;id'
confere "--so com .. recusa" 2 main --so '../x.test.ts'
confere "--acompanhar com pasta estranha recusa" 2 --acompanhar '/x;id'
[ ! -s "$SSH_LOG" ] && echo "ok   nada recusado chegou ao ssh" || { echo "FAIL ssh chamado em caso recusado"; falhas=$((falhas+1)); }

confere "branch válida com barra passa" 0 lote/2026-11-19-b --script-local
tem "checkout recebe a branch e o repositório" 'bash -s -- lote/2026-11-19-b https://github.com/Hiperbold-Company/hiperbold-crm.git'
tem "--script-local envia o remoto" '\.scripts/verificar-remoto\.sh'
tem "--script-local envia o e2e" '\.scripts/verificar-e2e\.sh'
tem "dispara desacoplado (setsid nohup) o script local" 'setsid nohup bash \$HOME/verificacao/\.scripts/verificar-remoto\.sh --rodada'
tem "acompanha a rodada disparada" '/fake/logs/rodada/resumo\.txt'
tem "ssh com keepalive" 'ServerAliveInterval=30'
nao_tem "rodada inteira não leva --so nem --sem-status" 'setsid nohup.*(--so|--sem-status)'

confere "sem --script-local usa o script da branch" 0 main
tem "script da branch disparado" 'setsid nohup bash \$HOME/verificacao/hiperbold-crm/hiperbold/scripts/verificar-remoto\.sh'

confere "--so com arquivo unit passa adiante" 0 main --so tests/unit/opt-out-deteccao.test.ts
tem "--so chega ao remoto" 'setsid nohup.*--so tests/unit/opt-out-deteccao\.test\.ts'
confere "--so com spec e2e passa adiante" 0 main --so tests/e2e/smoke.spec.ts
tem "--so e2e chega ao remoto" '--so tests/e2e/smoke\.spec\.ts'
confere "--sem-status passa adiante" 0 main --sem-status
tem "--sem-status chega ao remoto" 'setsid nohup.*--sem-status'

confere "--sem-esperar sai sem acompanhar" 0 main --sem-esperar
nao_tem "--sem-esperar não lê o resumo" '__LINHAS__'

FIM_RC=1 confere "o exit code da rodada volta ao Mac" 1 main
confere "--acompanhar sem pasta segue a última rodada" 0 --acompanhar
tem "--acompanhar lê a última" '/fake/logs/ultima-rodada/resumo\.txt'
nao_tem "--acompanhar não mexe no clone" 'bash -s --'

for alvo in --apagar "--so" "--so ../x" "--so a;b"; do
  # shellcheck disable=SC2086
  bash "$AQUI/verificar-remoto.sh" $alvo > /dev/null 2>&1
  [ $? = 2 ] && echo "ok   parte remota recusa '$alvo'" || { echo "FAIL parte remota aceitou '$alvo'"; falhas=$((falhas+1)); }
done

echo "falhas: $falhas"
[ "$falhas" = 0 ]
