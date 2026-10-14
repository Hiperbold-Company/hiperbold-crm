#!/usr/bin/env bash
# Backup diário do banco de PRODUÇÃO (Supabase Cloud), como serviço do EasyPanel.
# Faz o mesmo que hiperbold/scripts/backup-prod.sh, mas dentro do container e
# mandando os arquivos CIFRADOS para uma pasta do Google Drive.
#
# Uso:
#   rodar.sh          fica em laço: dorme até HORA_DO_BACKUP (fuso TZ), roda, repete.
#   rodar.sh agora    faz UMA rodada e sai (0 = ok, 1 = falhou).
#
# Variáveis:
#   SUPABASE_DB_URL                 obrigatória. URL do banco (com a senha). Nunca é impressa.
#   AGE_RECIPIENT                   obrigatória. Chave PÚBLICA age (age1...). Sem ela o script
#                                   RECUSA: nunca envia backup em claro para o Drive.
#   RCLONE_CONFIG_DRIVE_TOKEN       obrigatória. JSON do OAuth do Google Drive (rclone).
#   RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID  obrigatória. ID da pasta do Drive (a raiz do remoto).
#   HORA_DO_BACKUP                  padrão 12:30
#   TZ                              padrão America/Sao_Paulo
#   RETENCAO_LOCAL_DIAS             padrão 7
#   RETENCAO_DRIVE_DIAS             padrão 30
#   PASTA_LOCAL                     padrão /backups (monte um volume aqui)
#
# O Drive é configurado SÓ por variáveis de ambiente do rclone (sem arquivo de config):
# o remoto se chama `drive`, então RCLONE_CONFIG_DRIVE_TYPE=drive e
# RCLONE_CONFIG_DRIVE_SCOPE=drive (este script já define os dois). O rclone renova o
# access_token sozinho, em memória, usando o refresh_token do JSON; o refresh_token não
# expira em uso normal, então o token da variável continua valendo.
#
# O dump leva hash de senha, dado pessoal e (schema `private`) a chave de cifra dos
# tokens. Por isso: umask 077, arquivos 0600, e o que sobe ao Drive é sempre `.age`.
# `private` sai em arquivo separado do resto, como em backup-prod.sh.
set -Eeuo pipefail
umask 077

: "${HORA_DO_BACKUP:=12:30}"
: "${RETENCAO_LOCAL_DIAS:=7}"
: "${RETENCAO_DRIVE_DIAS:=30}"
: "${PASTA_LOCAL:=/backups}"
export TZ="${TZ:-America/Sao_Paulo}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Falha alto, com o prefixo que o monitoramento procura, e sai com erro.
falhar() {
  printf '%s BACKUP FALHOU: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
  exit 1
}

# Repassa o texto trocando URL do banco, senha, token e ID da pasta por marcadores,
# para uma mensagem de erro do pg_dump ou do rclone nunca vazar segredo no log.
sem_segredos() {
  local linha resto senha
  local segredos=()
  [ -n "${SUPABASE_DB_URL:-}" ] && segredos+=("$SUPABASE_DB_URL")
  if [[ "${SUPABASE_DB_URL:-}" == *://*:*@* ]]; then
    resto="${SUPABASE_DB_URL#*://}"
    resto="${resto%@*}"
    senha="${resto#*:}"
    [ "${#senha}" -ge 4 ] && segredos+=("$senha")
  fi
  [ -n "${RCLONE_CONFIG_DRIVE_TOKEN:-}" ] && segredos+=("$RCLONE_CONFIG_DRIVE_TOKEN")
  [ -n "${RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID:-}" ] && segredos+=("$RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID")
  while IFS= read -r linha || [ -n "$linha" ]; do
    for s in "${segredos[@]}"; do linha="${linha//"$s"/***}"; done
    printf '%s\n' "$linha"
  done
}

# Recusa de ambiente: tudo o que é obrigatório, antes de qualquer trabalho.
conferir_ambiente() {
  [ -n "${AGE_RECIPIENT:-}" ] \
    || falhar "AGE_RECIPIENT não definida (chave pública age1...). Recuso enviar backup sem cifra."
  [[ "$AGE_RECIPIENT" == age1* ]] \
    || falhar "AGE_RECIPIENT não parece uma chave pública age (deve começar com age1). A chave privada nunca vai aqui."
  [ -n "${SUPABASE_DB_URL:-}" ] || falhar "SUPABASE_DB_URL não definida."
  [ -n "${RCLONE_CONFIG_DRIVE_TOKEN:-}" ] || falhar "RCLONE_CONFIG_DRIVE_TOKEN não definida (JSON do OAuth do Drive)."
  [ -n "${RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID:-}" ] || falhar "RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID não definida (ID da pasta do Drive)."
  [[ "$HORA_DO_BACKUP" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] \
    || falhar "HORA_DO_BACKUP inválida: '$HORA_DO_BACKUP' (use HH:MM, 00:00 a 23:59)."
  [[ "$RETENCAO_LOCAL_DIAS" =~ ^[0-9]+$ && "$RETENCAO_DRIVE_DIAS" =~ ^[0-9]+$ ]] \
    || falhar "RETENCAO_LOCAL_DIAS e RETENCAO_DRIVE_DIAS devem ser números inteiros."
  export RCLONE_CONFIG_DRIVE_TYPE=drive
  export RCLONE_CONFIG_DRIVE_SCOPE=drive
}

# Segundos (1 a 86400) até a próxima ocorrência de HH:MM no fuso TZ. Se a hora já
# passou hoje, conta até amanhã; se for exatamente agora, espera 24 h.
segundos_ate_proxima() {
  local alvo="$1" h m agora_h agora_m agora_s alvo_s agora_total diff
  h="${alvo%%:*}"; m="${alvo##*:}"
  read -r agora_h agora_m agora_s < <(date '+%H %M %S')
  alvo_s=$((10#$h * 3600 + 10#$m * 60))
  agora_total=$((10#$agora_h * 3600 + 10#$agora_m * 60 + 10#$agora_s))
  diff=$((alvo_s - agora_total))
  [ "$diff" -le 0 ] && diff=$((diff + 86400))
  echo "$diff"
}

tamanho_do_arquivo() { wc -c <"$1" | tr -d ' '; }

# Não deixa dump em claro nem parcial no volume, nem quando a rodada falha.
limpar_claro() {
  rm -f "$PASTA_LOCAL"/.hiperbold-crm-*.parcial 2>/dev/null || true
  rm -f "$PASTA_LOCAL"/hiperbold-crm-*.dump 2>/dev/null || true
}

# Uma rodada: dump, validação, cifra, envio, conferência e retenção.
# Qualquer comando que falhe cai no trap ERR e vira "BACKUP FALHOU".
rodada() {
  local stamp nome nome_private tmp tmp_private tabelas erro f
  local enviados=() tamanho_local tamanho_drive linhas

  mkdir -p "$PASTA_LOCAL"
  chmod 700 "$PASTA_LOCAL" 2>/dev/null || true
  trap limpar_claro EXIT
  limpar_claro

  stamp="$(date +%Y-%m-%d_%H%M)"
  nome="hiperbold-crm-$stamp.dump"
  nome_private="hiperbold-crm-$stamp-private.dump"
  tmp="$PASTA_LOCAL/.$nome.parcial"
  tmp_private="$PASTA_LOCAL/.$nome_private.parcial"
  erro="$(mktemp)"

  log "iniciando backup: $nome"
  if ! pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
      --schema=public --schema=auth --file="$tmp" 2>"$erro"; then
    sem_segredos <"$erro" >&2
    rm -f "$erro"
    falhar "pg_dump de public e auth falhou."
  fi
  if ! pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
      --schema=private --file="$tmp_private" 2>"$erro"; then
    sem_segredos <"$erro" >&2
    rm -f "$erro"
    falhar "pg_dump de private falhou."
  fi
  rm -f "$erro"
  chmod 600 "$tmp" "$tmp_private"

  # Só vira backup o que o pg_restore consegue LER: arquivo truncado por queda de
  # rede no meio do dump não pode ocupar o lugar de um bom.
  tabelas="$(pg_restore --list "$tmp" | grep -c 'TABLE DATA' || true)"
  if [ "${tabelas:-0}" -lt 50 ]; then
    falhar "dump inválido: só ${tabelas:-0} tabelas legíveis em public/auth (mínimo 50). Nada foi enviado."
  fi
  pg_restore --list "$tmp_private" >/dev/null \
    || falhar "dump de private ilegível pelo pg_restore. Nada foi enviado."
  log "dumps validados: $tabelas tabelas com dados"

  mv "$tmp" "$PASTA_LOCAL/$nome"
  mv "$tmp_private" "$PASTA_LOCAL/$nome_private"

  # Cifra com chave PÚBLICA: o que fica no volume e no Drive não se lê sem a chave
  # privada, que NÃO fica neste serviço. O arquivo em claro é removido na hora.
  for f in "$nome" "$nome_private"; do
    age -r "$AGE_RECIPIENT" -o "$PASTA_LOCAL/$f.age" "$PASTA_LOCAL/$f" \
      || falhar "age não conseguiu cifrar $f. Nada foi enviado."
    chmod 600 "$PASTA_LOCAL/$f.age"
    rm -f "$PASTA_LOCAL/$f"
    enviados+=("$f.age")
  done
  log "cifrados com age: ${enviados[*]} (os arquivos em claro foram removidos)"

  # Envio ao Drive (a pasta raiz do remoto é a do ID) e conferência por tamanho.
  erro="$(mktemp)"
  for f in "${enviados[@]}"; do
    if ! rclone copy "$PASTA_LOCAL/$f" drive: 2>"$erro"; then
      sem_segredos <"$erro" >&2
      rm -f "$erro"
      falhar "rclone não conseguiu enviar $f ao Drive."
    fi
    if ! linhas="$(rclone lsf drive: --files-only --format 'sp' --separator ';' --include "$f" 2>"$erro")"; then
      sem_segredos <"$erro" >&2
      rm -f "$erro"
      falhar "rclone não conseguiu listar $f no Drive para conferir."
    fi
    tamanho_local="$(tamanho_do_arquivo "$PASTA_LOCAL/$f")"
    tamanho_drive="${linhas%%;*}"
    if [ "$tamanho_drive" != "$tamanho_local" ] || [ -z "$linhas" ]; then
      rm -f "$erro"
      falhar "$f não chegou inteiro ao Drive (local ${tamanho_local} bytes, Drive '${tamanho_drive:-ausente}')."
    fi
  done
  rm -f "$erro"
  log "conferido no Drive: ${enviados[*]} com o mesmo tamanho do local"

  # Retenção. Falha aqui não invalida o backup que já chegou: só avisa.
  rclone delete drive: --min-age "${RETENCAO_DRIVE_DIAS}d" --include 'hiperbold-crm-*.age' 2>&1 \
    | sem_segredos || log "AVISO: não consegui apagar backups antigos do Drive (retenção de ${RETENCAO_DRIVE_DIAS} dias)."
  find "$PASTA_LOCAL" -maxdepth 1 -name 'hiperbold-crm-*.age' -mtime +"$RETENCAO_LOCAL_DIAS" -delete \
    || log "AVISO: não consegui apagar backups locais antigos."

  log "backup ok: ${enviados[0]} e ${enviados[1]}, $(cd "$PASTA_LOCAL" && du -ch "${enviados[@]}" | tail -1 | cut -f1), $tabelas tabelas, enviado ao Drive"
}

# Laço do serviço. Cada rodada é um processo filho (`rodar.sh agora`), então o
# `set -e` vale inteiro dentro dela e uma falha nunca derruba o laço.
laco() {
  local s
  trap 'log "sinal recebido, encerrando"; exit 0' TERM INT
  log "serviço de backup no ar: todo dia às $HORA_DO_BACKUP ($TZ)"
  # RODAR_AO_INICIAR=1 faz uma rodada assim que o serviço sobe:
  # serve para conferir um deploy novo (ou a primeira instalação) sem esperar o horário.
  if [ "${RODAR_AO_INICIAR:-0}" = "1" ]; then
    log "RODAR_AO_INICIAR=1: rodada imediata"
    bash "${BASH_SOURCE[0]}" agora || log "a rodada inicial falhou (veja BACKUP FALHOU acima)"
  fi
  while true; do
    s="$(segundos_ate_proxima "$HORA_DO_BACKUP")"
    log "próximo backup em ${s}s"
    # `wait` no lugar de `sleep` direto: assim o TERM do Docker interrompe a espera.
    sleep "$s" &
    wait $! || true
    if bash "${BASH_SOURCE[0]}" agora; then
      :
    else
      log "a rodada falhou (veja BACKUP FALHOU acima); tento de novo amanhã às $HORA_DO_BACKUP"
    fi
  done
}

principal() {
  trap 'falhar "erro inesperado na linha $LINENO"' ERR
  case "${1:-}" in
    agora) conferir_ambiente; rodada ;;
    "") conferir_ambiente; laco ;;
    *) echo "uso: rodar.sh [agora]" >&2; exit 2 ;;
  esac
}

# Guarda: com `source` (teste) só as funções são carregadas.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  principal "$@"
fi
