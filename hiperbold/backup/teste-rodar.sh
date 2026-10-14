#!/usr/bin/env bash
# Prova, sem rede e sem banco, as recusas de rodar.sh e o cálculo da hora do próximo
# backup. Uso: bash hiperbold/backup/teste-rodar.sh
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$AQUI/rodar.sh"
falhas=0

confere() { # confere <descrição> <condição verdadeira = 0>
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FALHA $1"; falhas=$((falhas + 1)); fi
}

# Ambiente completo; cada caso tira UMA variável.
base=(
  SUPABASE_DB_URL="postgresql://u:senha-secreta@127.0.0.1:1/db"
  AGE_RECIPIENT="age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
  RCLONE_CONFIG_DRIVE_TOKEN='{"access_token":"x"}'
  RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID="pasta-de-teste"
  PASTA_LOCAL="$(mktemp -d)"
)
sem() { local v="$1" e=(); for kv in "${base[@]}"; do [[ "$kv" == "$v="* ]] || e+=("$kv"); done; printf '%s\n' "${e[@]}"; }
rodar_sem() { # rodar_sem <variável a tirar> -> saída em $saida, código em $codigo
  local e=(); while IFS= read -r l; do e+=("$l"); done < <(sem "$1")
  saida="$(env -i PATH="$PATH" "${e[@]}" bash "$SCRIPT" agora 2>&1)"; codigo=$?
}

rodar_sem AGE_RECIPIENT
[ "$codigo" -ne 0 ] && [[ "$saida" == *"BACKUP FALHOU: AGE_RECIPIENT não definida"* ]]
confere "sem AGE_RECIPIENT recusa com a mensagem certa" $?

rodar_sem RCLONE_CONFIG_DRIVE_TOKEN
[ "$codigo" -ne 0 ] && [[ "$saida" == *"BACKUP FALHOU: RCLONE_CONFIG_DRIVE_TOKEN não definida"* ]]
confere "sem RCLONE_CONFIG_DRIVE_TOKEN recusa com a mensagem certa" $?

rodar_sem RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID
[ "$codigo" -ne 0 ] && [[ "$saida" == *"BACKUP FALHOU: RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID não definida"* ]]
confere "sem ROOT_FOLDER_ID recusa com a mensagem certa" $?

rodar_sem SUPABASE_DB_URL
[ "$codigo" -ne 0 ] && [[ "$saida" == *"BACKUP FALHOU: SUPABASE_DB_URL não definida"* ]]
confere "sem SUPABASE_DB_URL recusa com a mensagem certa" $?

# Chave privada colada por engano no lugar da pública: recusa.
saida="$(env -i PATH="$PATH" "${base[@]}" AGE_RECIPIENT="AGE-SECRET-KEY-1XXXX" bash "$SCRIPT" agora 2>&1)"; codigo=$?
[ "$codigo" -ne 0 ] && [[ "$saida" == *"age1"* ]]
confere "AGE_RECIPIENT que não começa com age1 é recusada" $?

# A saída de uma recusa nunca mostra a URL do banco nem o token.
[[ "$saida" != *"senha-secreta"* && "$saida" != *"access_token"* ]]
confere "a saída não vaza segredo" $?

# Função de espera: carrega só as funções (guarda BASH_SOURCE) e mede.
# shellcheck disable=SC1090
source "$SCRIPT"
set +e
for hora in 00:00 03:15 12:30 23:59; do
  s="$(segundos_ate_proxima "$hora")"
  [[ "$s" =~ ^[0-9]+$ ]] && [ "$s" -ge 1 ] && [ "$s" -le 86400 ]
  confere "segundos_ate_proxima $hora = $s (entre 1 e 86400)" $?
done

# A hora de agora (no fuso) cai em 24 h, e um minuto à frente em até 60 s.
agora="$(date '+%H:%M')"
s="$(segundos_ate_proxima "$agora")"
[ "$s" -ge 86340 ] && [ "$s" -le 86400 ]
confere "a hora atual ($agora) espera quase 24 h ($s s)" $?

# Fuso: o mesmo cálculo muda com TZ, mas continua dentro da faixa.
s="$(TZ=Asia/Tokyo segundos_ate_proxima 12:30)"
[ "$s" -ge 1 ] && [ "$s" -le 86400 ]
confere "funciona em outro fuso (Tokyo: $s s)" $?

rm -rf "${base[4]#PASTA_LOCAL=}"
if [ "$falhas" -eq 0 ]; then echo "todos os testes passaram"; else echo "$falhas teste(s) falharam"; exit 1; fi
