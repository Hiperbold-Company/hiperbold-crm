# Verificação no WSL (`verificar`)

Roda no servidor `hiperbold-homolog` (WSL do PC Windows, 16 núcleos, 19 GB) os testes pesados do
CI do GitHub, em paralelo, e grava o resultado no commit como status `verificar/wsl`. Não pesa no
Mac e não usa runner self-hosted do GitHub (o repositório é público).

## Uso (do Mac)

```bash
bash hiperbold/scripts/verificar.sh <branch>                  # rodada inteira, com status
bash hiperbold/scripts/verificar.sh <branch> --script-local   # com os verificar-*.sh deste checkout
bash hiperbold/scripts/verificar.sh <branch> --so tests/unit/x.test.ts       # só um arquivo unit
bash hiperbold/scripts/verificar.sh <branch> --so tests/invariants/x.test.ts # só um invariante (db)
bash hiperbold/scripts/verificar.sh <branch> --so tests/e2e/x.spec.ts        # só uma spec e2e
bash hiperbold/scripts/verificar.sh <branch> --so unit        # só uma etapa: install|typecheck|lint|unit|db|e2e
bash hiperbold/scripts/verificar.sh <branch> --sem-status     # rodada inteira sem status (medição)
bash hiperbold/scripts/verificar.sh <branch> --sem-esperar    # dispara e sai
bash hiperbold/scripts/verificar.sh --acompanhar [pasta]      # volta a acompanhar (padrão: a última)
bash hiperbold/scripts/verificar.test.sh                      # teste do comando, sem servidor
```

- A branch precisa estar no GitHub (push antes). O clone `~/verificacao/hiperbold-crm` vai para
  `origin/<branch>` com `reset --hard` e `clean` (sem `-x`, o `node_modules` fica): é só da
  verificação. Se não existir, é clonado do GitHub.
- A rodada roda no servidor com `setsid nohup`: a queda do ssh, do Mac ou da sessão do Claude não
  a interrompe. O Mac só lê o resumo a cada 20 s e, no fim, sai com o exit code da rodada. Se a
  conexão cair, `--acompanhar` retoma.
- `--so` é a ferramenta para provar uma correção antes do push (regra 1 de
  `falhas-de-processo.md`). Nunca publica status: um arquivo verde não é selo do commit. A spec
  e2e roda com o preparo da parte do `e2e.yml` em que ela está.
- Uma rodada por vez (trava em `~/verificacao/.verificar.lock`).

## O que roda

Depois do install, tudo ao mesmo tempo, cada etapa com o seu log:

| Etapa | Comando |
|---|---|
| install | `pnpm install --frozen-lockfile` (pnpm de `packageManager`, pelo corepack) |
| typecheck | `pnpm typecheck` com `NODE_OPTIONS=--max-old-space-size=8192` |
| lint | `pnpm lint` |
| unit | `pnpm test:unit` (a suíte inteira, os dois projetos, um processo) |
| db-1..6 | `pnpm test:db --shard=i/6`, cada parte com o seu Postgres efêmero em `127.0.0.1:16500+i-1` |
| db-cobertura | as partes juntas cobriram cada arquivo de `tests/invariants` uma vez (relatório json) |
| e2e | `verificar-e2e.sh`: as 8 partes do `e2e.yml` em 3 pistas paralelas |

- Portões de memória: o build do e2e espera o typecheck, o unit (`--maxWorkers=8`) espera o
  build, e tudo roda com `nice 10` (a homologação e o Supabase de dev dividem o servidor).
- Cada etapa vale pelo exit code. Falha no install pula o resto; as demais rodam todas.
- Logs: `~/verificacao/logs/<data>-<sha>/` (`<etapa>.log`, `resumo.txt`, `memoria.log`,
  `e2e/parte-N.log`); `~/verificacao/logs/ultima` aponta para a última.
- Status: `success` ou `failure` com as etapas que falharam, publicado pelo `gh` do WSL.
- Variáveis: `VERIFICAR_DB_PARTES` (1 a 10), `VERIFICAR_E2E_PISTAS` (1 a 8),
  `VERIFICAR_UNIT_WORKERS`.

### E2E

- Lê as `SPECS_PARTE_*` do `e2e.yml` da própria branch e distribui as partes nas pistas (a mais
  longa primeiro, na pista menos carregada; o peso é o último tempo medido, em
  `~/verificacao/e2e/tempos.txt`).
- Cada pista tem um Supabase da CLI 2.117.0 (projeto `hiperbold-verificacao-<n>`, rede Docker com
  `host_binding` `127.0.0.<n>`, portas 16510-16514) e um contêiner da imagem do Playwright do repo
  com rede própria. Dentro dele o Supabase aparece em `127.0.0.1:54321/54322/54324` e o app em
  `localhost:3001`, como no CI: as portas fixas do `e2e.yml`, do `.env.e2e` e das specs (dublês
  3995-3999 e 56331, WAHA 3000, Redis 6379/8079) não tocam nas portas do servidor e não colidem
  entre pistas. Nenhum arquivo do CI foi mudado.
- Um `next build` (com `next start` dentro das pistas) serve todas: o Supabase tem o mesmo endereço
  e as mesmas chaves em todas (conferido a cada parte). Cada parte recebe um Supabase novo com o
  `baseline.sql`.
- Árvore própria em `~/verificacao/e2e/arvore` (o e2e mexe em `.env.local` e `.next`) e uma por
  pista em `~/verificacao/e2e/pista-<n>`. Contêineres, redes e volumes saem no fim.
- Fica de fora: os passos de evidência do `e2e.yml` (gerar tipos do banco, upload de relatório)
  e os orçamentos de relógio do GitHub.

## Tempos medidos

Branch `lote/2026-11-19-b` (82c8680a9), 19/11/2026, servidor dividido com a homologação e o
Supabase de dev.

| Etapa | Em série (antes) | Em paralelo (agora) |
|---|---|---|
| install | 1 s | 2 s |
| typecheck | 2 min 45 s | 38 s (cache incremental do tsc no clone) |
| lint | 1 min 39 s | 3 min 4 s |
| unit | 11 min 10 s | 27 min 52 s (começa depois do build, aos ~6 min) |
| db | 38 min 50 s (1 Postgres) | 13-20 min (6 partes: 807-1206 s) |
| e2e | não rodava | 37 min 58 s (3 pistas; build 236 s) |
| **total** | **54 min, sem e2e** | **38 min, com e2e** |

E2E por parte (inclui Supabase novo e sementes): 1 = 742 s, 2 = 548 s, 3 = 425 s, 4 = 99 s,
5 = 1690 s, 6 = 1607 s, 7 = 1221 s; a 8 não rodou (defeito de corrida já corrigido no script).
Pico de memória: 15,6 GB usados, 2,6 GB livres no pior momento.

**A meta de 20 min não cabe neste servidor.** A suíte unit sozinha soma ~10.000 s de CPU (726 s
de relógio com 14 núcleos ocupados), e o e2e mais o db somam outro tanto: ~22 min de CPU cheia nos
16 núcleos, sem folga. Medido:
- tudo de uma vez (unit sem limite, 8 partes de db, 4 pistas): load 200, 0,8 GB livres, ssh sem
  resposta; a rodada foi interrompida;
- com os portões acima: load 20-35, mas os vermelhos vêm de **relógio**, não de código:
  `Test timed out in 15000ms` (unit, 4 arquivos), timeouts de 30 s e `database "postgres" is
  being accessed by other users` no reset por arquivo (db, 4 partes), `Timeout 15000ms` de
  locator (e2e, partes 2, 6 e 7). Todos esses arquivos passam na rodada em série.
- Enquanto a carga der vermelho falso, o selo `verificar/wsl` não serve como prova.

## O que não roda

- O resto que o CI roda a mais: `test:db:update`, a perna do Postgres 17, `test:shell`, cercas
  separadas (rodam dentro do `test:unit`), `lint:channels`, `lint:role-rank`, colisão de migration
  e `imagens-ok`.
