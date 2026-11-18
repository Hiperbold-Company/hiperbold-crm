#!/usr/bin/env bash
# PORTÃO PELO PR: o commit da main é o merge de um PR que JÁ foi provado?
# Usado pelo deploy-easypanel.yml ANTES do portão antigo
# (scripts/commit-passou-nos-testes.sh, que espera o reteste da main). Sai 0
# quando o merge já foi provado no PR e o deploy pode sair sem esperar; sai 1
# quando qualquer condição falha OU não pode ser medida, e diz qual. Quem chama
# cai, nesse caso, no comportamento antigo. Nunca libera por falta de leitura.
#
# Condições, todas obrigatórias, medidas pela API do GitHub:
#   (a) o commit pertence a um PR mesclado na main, com merge_commit_sha ==
#       commit, e o head do PR mora NESTE repositório (PR de fork não passa:
#       os runs dele não se amarram ao PR pela API);
#   (b) o merge commit tem 2 pais, o segundo é o head do PR, e a árvore do
#       merge (commit.tree.sha) é a MESMA do head: o que foi para a main é
#       byte a byte o que o CI do PR mediu;
#   (c) o PR estava em dia com a main: o primeiro pai do merge é ancestral do
#       head (compare pai1...head com behind_by == 0);
#   (d) o reteste da main deste commit ainda não falhou (ci/e2e em push já
#       concluídos com algo diferente de sucesso recusam o atalho);
#   (e) no head do PR, o ci.yml (pull_request, run amarrado a ESTE PR por
#       .pull_requests[].number) concluiu em success;
#   (f) caminho completo: o e2e.yml do PR concluiu em success e nenhum dos dois
#       runs foi pela rota urgente; OU rota urgente: o e2e.yml do PR concluiu em
#       success COM a marca urgente (ele mesmo pulou pela regra), o PR ainda tem
#       o rótulo e não mexe em caminho que exige a medida completa
#       (scripts/pr-rota-urgente.sh), e o perf.yml (o build) concluiu em success.
#       Marca ilegível nunca libera.
#
# Um run "foi pela rota urgente" quando um passo cujo nome começa com
# "Rota urgente" terminou em success num job dele. Isso decide pelo que o run
# MEDIU, não pelo rótulo de agora: tirar o rótulo depois não transforma um run
# que pulou a matriz em prova do caminho completo.
#
# Uso: GITHUB_REPOSITORY=dono/repo bash scripts/merge-ja-provado-no-pr.sh <sha>
# Precisa de `gh` autenticado (GH_TOKEN). Sai 2 em uso errado.
set -uo pipefail

sha="${1:-}"
repo="${GITHUB_REPOSITORY:-}"
if [ -z "$sha" ] || [ -z "$repo" ]; then
  echo "uso: GITHUB_REPOSITORY=dono/repo $0 <sha>" >&2
  exit 2
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "sha inválido: ${sha}" >&2
  exit 2
fi
aqui="$(cd "$(dirname "$0")" && pwd)"

recusa() {
  echo "portão pelo PR: NÃO liberado — $1"
  exit 1
}
ok() { echo "portão pelo PR: ok — $1"; }

# (a) o PR mesclado cujo merge commit é este.
filtro_pr="[.[] | select(.merge_commit_sha == \"${sha}\" and .merged_at != null and .base.ref == \"main\")]
           | first | select(. != null) | [(.number|tostring), .head.sha, (.head.repo.full_name // \"\"), (.head.ref // \"\")] | @tsv"
if ! linha=$(gh api "repos/${repo}/commits/${sha}/pulls" --jq "$filtro_pr" 2>/dev/null); then
  recusa "(a) não consegui consultar os PRs do commit ${sha}"
fi
IFS=$'\t' read -r pr head origem ramo <<<"$linha"
if [ -z "$linha" ] || ! printf '%s' "${pr:-}" | grep -Eq '^[0-9]+$' || ! printf '%s' "${head:-}" | grep -Eq '^[0-9a-f]{40}$'; then
  recusa "(a) ${sha} não é o merge commit de um PR mesclado na main"
fi
if [ "${origem:-}" != "$repo" ]; then
  recusa "(a) o head do PR #${pr} mora em '${origem:-?}', não em ${repo}: PR de fork não passa pelo atalho"
fi
if ! printf '%s' "${ramo:-}" | grep -Eq '^[A-Za-z0-9._/-]+$'; then
  recusa "(a) não consegui ler o ramo do head do PR #${pr}"
fi
ok "(a) ${sha} é o merge do PR #${pr} (head ${head})"

# (b) merge commit de 2 pais, o segundo é o head do PR.
if ! pais=$(gh api "repos/${repo}/commits/${sha}" --jq '[.commit.tree.sha, (.parents[].sha)] | join(" ")' 2>/dev/null); then
  recusa "(b) não consegui ler os pais de ${sha}"
fi
# shellcheck disable=SC2086 # separar árvore e pais pelo espaço é o objetivo
set -- $pais
arvore_merge="${1:-}"
[ "$#" -gt 0 ] && shift
if [ "$#" -ne 2 ]; then
  recusa "(b) ${sha} tem $# pai(s), não é merge commit de 2 pais (squash ou rebase não passam pelo atalho)"
fi
pai1="$1"
pai2="$2"
if [ "$pai2" != "$head" ]; then
  recusa "(b) o segundo pai (${pai2}) não é o head do PR #${pr} (${head})"
fi
if ! arvore_head=$(gh api "repos/${repo}/commits/${head}" --jq '.commit.tree.sha' 2>/dev/null) \
   || ! printf '%s' "$arvore_head" | grep -Eq '^[0-9a-f]{40}$' \
   || ! printf '%s' "$arvore_merge" | grep -Eq '^[0-9a-f]{40}$'; then
  recusa "(b) não consegui ler as árvores do merge e do head"
fi
if [ "$arvore_merge" != "$arvore_head" ]; then
  recusa "(b) a árvore do merge (${arvore_merge}) difere da do head (${arvore_head}): a main recebeu algo que o CI do PR não mediu"
fi
ok "(b) merge de 2 pais, o segundo é o head do PR, mesma árvore"

# (c) o PR estava em dia com a main no momento do merge.
if ! atras=$(gh api "repos/${repo}/compare/${pai1}...${head}" --jq '.behind_by' 2>/dev/null); then
  recusa "(c) não consegui comparar ${pai1}...${head}"
fi
if [ "$atras" != "0" ]; then
  recusa "(c) o PR #${pr} estava ${atras:-?} commit(s) atrás da main no merge: o CI dele não mediu esta árvore"
fi
ok "(c) o PR estava em dia com a main (behind_by 0)"

# A execução mais recente de um workflow para um commit num evento. Em
# pull_request, só vale run amarrado a ESTE PR (o mesmo head pode estar em
# outro PR, com outro rótulo e outra base): `.pull_requests[].number == pr`.
# A API ESVAZIA `.pull_requests` depois do merge quando o ramo é apagado
# (medido no PR #58: run 44197199541 com `pull_requests: []`); só nesse caso
# vale o ramo e o repositório do head do PR como amarra.
# Devolve "id<TAB>status<TAB>conclusion", ou vazio quando não há execução.
ultimo_run() {
  local wf="$1" alvo="$2" evento="$3" amarra=""
  if [ "$evento" = "pull_request" ]; then
    amarra=" and (any(.pull_requests[]?; .number == ${pr})
                  or ((.pull_requests | length) == 0 and .head_branch == \"${ramo}\"
                      and .head_repository.full_name == \"${repo}\"))"
  fi
  gh api "repos/${repo}/actions/workflows/${wf}/runs?head_sha=${alvo}&event=${evento}&per_page=30" \
    --jq "[.workflow_runs[] | select(.event == \"${evento}\"${amarra})] | sort_by(.run_number) | last
          | select(. != null) | [(.id|tostring), (.status // \"\"), (.conclusion // \"\")] | @tsv" 2>/dev/null
}

# (d) o reteste da main deste commit não pode já ter falhado.
for wf in ci.yml e2e.yml; do
  if ! r=$(ultimo_run "$wf" "$sha" push); then
    recusa "(d) não consegui consultar o reteste ${wf} da main"
  fi
  IFS=$'\t' read -r _ st co <<<"$r"
  if [ "${st:-}" = "completed" ] && [ "${co:-}" != "success" ]; then
    recusa "(d) o reteste ${wf} da main já terminou em '${co}' para ${sha}"
  fi
done
ok "(d) o reteste da main não falhou (ainda pode estar rodando)"

# Quantos passos "Rota urgente…" terminaram em success no run. Erro: vazio.
# Seis tentativas: a lista de jobs do e2e (com todos os passos) é a resposta
# mais pesada que o portão pede, e medido em 18/11/2026 ela devolveu HTTP 502
# em 4 de 8 leituras seguidas do mesmo run. Erro persistente segue sendo "não medido".
marcas_urgentes() {
  local tentativa resposta
  for tentativa in 1 2 3 4 5 6; do
    if resposta=$(gh api "repos/${repo}/actions/runs/$1/jobs?filter=latest&per_page=100" \
      --jq '[.jobs[].steps[]? | select((.name | startswith("Rota urgente")) and .conclusion == "success")] | length' 2>/dev/null) \
      && printf '%s' "$resposta" | grep -Eq '^[0-9]+$'; then
      echo "$resposta"
      return 0
    fi
    [ "$tentativa" = 6 ] || sleep "${ESPERA_RETENTATIVA:-5}"
  done
  return 1
}

# (e) o ci.yml do head do PR.
if ! r=$(ultimo_run ci.yml "$head" pull_request) || [ -z "$r" ]; then
  recusa "(e) não achei o ci.yml (pull_request) do head ${head}"
fi
IFS=$'\t' read -r ci_id st co <<<"$r"
if [ "$st" != "completed" ] || [ "$co" != "success" ]; then
  recusa "(e) o ci.yml do head do PR está '${st}/${co:-}', não 'completed/success'"
fi
ci_marcas=$(marcas_urgentes "$ci_id") || ci_marcas=""
if ! printf '%s' "$ci_marcas" | grep -Eq '^[0-9]+$'; then
  recusa "(e) não consegui ler os jobs do ci.yml do PR (run ${ci_id})"
fi
ok "(e) ci.yml do PR em success (run ${ci_id})"

# (f) e2e no caminho completo, ou a rota urgente.
# e2e_estado: medido | urgente | ilegivel | outro (sem run, rodando, falhou).
e2e_estado=outro
e2e_desc="sem execução"
if r=$(ultimo_run e2e.yml "$head" pull_request) && [ -n "$r" ]; then
  IFS=$'\t' read -r e2e_id st co <<<"$r"
  e2e_desc="${st}/${co:-}"
  if [ "$st" = "completed" ] && [ "$co" = "success" ]; then
    if ! e2e_marcas=$(marcas_urgentes "$e2e_id"); then
      e2e_estado=ilegivel
      e2e_desc="success, jobs ilegíveis"
    elif [ "$e2e_marcas" = "0" ]; then
      e2e_estado=medido
    else
      e2e_estado=urgente
      e2e_desc="success pela rota urgente (partes puladas)"
    fi
  fi
fi

if [ "$ci_marcas" = "0" ] && [ "$e2e_estado" = "medido" ]; then
  ok "(f) caminho completo: e2e.yml do PR em success (run ${e2e_id})"
  echo "portão pelo PR: LIBERADO — PR #${pr} provado no caminho completo"
  exit 0
fi

# Daqui em diante só a rota urgente libera, e só se o PRÓPRIO run do e2e pulou
# pela regra (marca urgente lida). e2e rodando, sem run, vermelho, ou com marca
# ilegível: recusa, e o deploy espera o reteste da main.
if [ "$e2e_estado" != "urgente" ]; then
  recusa "(f) o e2e.yml do PR não foi medido no caminho completo nem pulado pela rota urgente (${e2e_desc}); ci com marca urgente: ${ci_marcas}"
fi
motivos=$(mktemp)
resposta=$(bash "${aqui}/pr-rota-urgente.sh" "$pr" 2>"$motivos") || resposta=nao
rota=$(tail -1 "$motivos")
rm -f "$motivos"
if [ "$resposta" != "sim" ]; then
  recusa "(f) o e2e do PR não mediu (${e2e_desc}) e a rota urgente não vale: ${rota#rota urgente: }"
fi
if ! r=$(ultimo_run perf.yml "$head" pull_request) || [ -z "$r" ]; then
  recusa "(f) rota urgente sem o perf.yml (build) do head ${head}"
fi
IFS=$'\t' read -r perf_id st co <<<"$r"
if [ "$st" != "completed" ] || [ "$co" != "success" ]; then
  recusa "(f) rota urgente: o perf.yml (build) do PR está '${st}/${co:-}', não 'completed/success'"
fi
ok "(f) rota urgente: e2e do PR pulado pela regra (run ${e2e_id}), rótulo presente, nada que exija o caminho completo, build em success (run ${perf_id})"
echo "portão pelo PR: LIBERADO — PR #${pr} pela rota urgente (o reteste da main segue e o alarme vigia)"
exit 0
