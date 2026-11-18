#!/usr/bin/env bash
# ALARME: o reteste da main falhou num commit que JÁ FOI para a produção.
# Usado pelo alarme-reteste-da-main.yml (exclusivo do fork Hiperbold) quando o
# ci ou o e2e de um push na main termina em `failure`. Com o portão pelo PR
# (scripts/merge-ja-provado-no-pr.sh), o deploy sai antes do reteste da main;
# este script é o que torna o vermelho posterior visível. Não faz rollback.
#
# Decide em três perguntas, e só abre issue quando as três dizem sim:
#   1. A falha é real? Run SUPERADO também termina em `failure`: o push novo
#      cancela os jobs pesados do anterior e o agregador (`verify`,
#      `invariants`, `e2e`) lê `cancelled` e reprova. Mas o job que estoura o
#      `timeout-minutes` TAMBÉM aparece como `cancelled` na API (medido no run
#      37675215958 da main: `e2e-parte (2)` cancelado aos 30 min exatos). Então:
#        - job de medida (não agregador) em `failure`/`timed_out`: real;
#        - só `cancelled`: superado APENAS se um run mais novo do mesmo
#          workflow, em push na main, nasceu antes do último cancelamento.
#          Sem esse run mais novo, é teto estourado ou cancelamento manual: real;
#        - qualquer leitura que falhe: real. O alarme erra para o lado de avisar.
#   2. O deploy deste commit saiu? O deploy-easypanel.yml grava o sha no nome
#      do run (`run-name`); vale o run concluído em `success` com o sha no
#      título. Run de deploy ainda em andamento: espera até o teto; estourado,
#      reprova este run (vermelho no Actions) em vez de abrir issue no escuro.
#   3. Já há issue aberta para o sha? Então comenta o link novo, não duplica.
#
# Uso: GITHUB_REPOSITORY=dono/repo RUN_ID=<id> SHA=<sha> WORKFLOW_NOME=<nome> \
#      RUN_URL=<url> bash scripts/alarme-reteste-da-main.sh
# Variáveis (para teste): TETO_SEGUNDOS (padrão 1200), INTERVALO_SEGUNDOS (30).
set -uo pipefail

repo="${GITHUB_REPOSITORY:-}"
run_id="${RUN_ID:-}"
sha="${SHA:-}"
nome="${WORKFLOW_NOME:-reteste}"
url="${RUN_URL:-}"
if [ -z "$repo" ] || ! printf '%s' "$run_id" | grep -Eq '^[0-9]+$' || ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "uso: GITHUB_REPOSITORY=dono/repo RUN_ID=<id> SHA=<sha40> $0" >&2
  exit 2
fi
teto="${TETO_SEGUNDOS:-1200}"
intervalo="${INTERVALO_SEGUNDOS:-30}"
limite=$(( $(date +%s) + teto ))

# 1. A falha é real?
api_jobs="repos/${repo}/actions/runs/${run_id}/jobs?filter=latest&per_page=100"
agregador='.name != "verify" and .name != "invariants" and .name != "e2e"'
filtro_falhos="[.jobs[] | select(.conclusion == \"failure\" or .conclusion == \"timed_out\") | select(${agregador}) | .name] | join(\", \")"
filtro_cancelados="[.jobs[] | select(.conclusion == \"cancelled\") | select(${agregador}) | .completed_at // \"\"] | max // \"\""
superado=nao
if ! falhos=$(gh api "$api_jobs" --jq "$filtro_falhos" 2>/dev/null); then
  falhos="(não consegui ler os jobs do run; tratado como falha real)"
elif [ -z "$falhos" ]; then
  if ! ultimo_cancelamento=$(gh api "$api_jobs" --jq "$filtro_cancelados" 2>/dev/null); then
    falhos="(não consegui ler os cancelamentos do run; tratado como falha real)"
  elif [ -z "$ultimo_cancelamento" ]; then
    falhos="(nenhum job de medida falhou nem foi cancelado, mas o run terminou em failure)"
  elif ! dados=$(gh api "repos/${repo}/actions/runs/${run_id}" --jq '[(.workflow_id|tostring), .created_at] | @tsv' 2>/dev/null) || [ -z "$dados" ]; then
    falhos="(cancelado, e não consegui ler o run para saber se foi superado; tratado como falha real)"
  else
    workflow_id="${dados%%$'\t'*}"
    criado="${dados#*$'\t'}"
    filtro_novos="[.workflow_runs[] | select(.id != ${run_id} and .created_at > \"${criado}\" and .created_at <= \"${ultimo_cancelamento}\")] | length"
    if novos=$(gh api "repos/${repo}/actions/workflows/${workflow_id}/runs?branch=main&event=push&per_page=30" --jq "$filtro_novos" 2>/dev/null) \
       && printf '%s' "$novos" | grep -Eq '^[1-9][0-9]*$'; then
      superado=sim
    else
      falhos="(job de medida cancelado sem push mais novo na main: teto estourado ou cancelamento manual)"
    fi
  fi
fi
if [ "$superado" = "sim" ]; then
  echo "sem alarme: o run ${run_id} só teve jobs cancelados por um push mais novo na main (run superado)"
  exit 0
fi
echo "falha real no ${nome} de ${sha}: ${falhos}"

# 2. O deploy deste commit saiu?
filtro_deploy="[.workflow_runs[] | select(.display_title | contains(\"${sha}\"))]
               | if any(.conclusion == \"success\") then \"saiu\"
                 elif any(.status != \"completed\") then \"andando\"
                 else \"nao\" end"
while :; do
  if deploy=$(gh api "repos/${repo}/actions/workflows/deploy-easypanel.yml/runs?per_page=50" --jq "$filtro_deploy" 2>/dev/null); then
    :
  else
    deploy="ilegivel"
  fi
  case "$deploy" in
    saiu) break ;;
    nao)
      echo "sem alarme: nenhum deploy de ${sha} concluiu em sucesso (o portão segurou, ou o deploy não chegou a sair)"
      exit 0 ;;
  esac
  if [ "$(date +%s)" -ge "$limite" ]; then
    # Deploy ainda andando depois do teto é, quase sempre, o portão antigo
    # esperando o reteste que acabou de falhar — e ele vai reprovar. Sem saber,
    # não abro issue: reprovo ESTE run, que fica vermelho no Actions.
    echo "::error::não sei se o deploy de ${sha} saiu (estado: ${deploy}, teto ${teto}s): confira o deploy-easypanel à mão"
    exit 1
  fi
  echo "esperando o deploy de ${sha} (estado: ${deploy})..."
  sleep "$intervalo"
done

# 3. Issue, sem duplicar.
titulo="Reteste da main falhou depois do deploy: ${sha}"
corpo="O **${nome}** do push na \`main\` terminou em \`failure\` para o commit \`${sha}\`, que já tinha ido para a produção pelo portão do PR.

- Execução: ${url:-run ${run_id}}
- Jobs que falharam: ${falhos}

Nada foi revertido automaticamente. Decida entre consertar para a frente (novo PR) ou reverter o merge. Feche esta issue quando a main voltar a ficar verde."

if ! existente=$(gh api --paginate "repos/${repo}/issues?state=open&per_page=100" \
      --jq ".[] | select(.pull_request == null and .title == \"${titulo}\") | .number" 2>/dev/null); then
  echo "::error::não consegui listar as issues abertas"
  exit 1
fi
existente=$(printf '%s\n' "$existente" | grep -E '^[0-9]+$' | head -1)

if [ -n "$existente" ]; then
  gh api -X POST "repos/${repo}/issues/${existente}/comments" \
    -f body="Mais uma falha do reteste para \`${sha}\`: **${nome}** — ${url:-run ${run_id}} (jobs: ${falhos})" >/dev/null \
    || { echo "::error::não consegui comentar na issue #${existente}"; exit 1; }
  echo "issue #${existente} já aberta para ${sha}: comentei o link novo"
  exit 0
fi

numero=$(gh api -X POST "repos/${repo}/issues" -f title="$titulo" -f body="$corpo" --jq '.number' 2>/dev/null) \
  || { echo "::error::não consegui abrir a issue"; exit 1; }
echo "abri a issue #${numero}: ${titulo}"
