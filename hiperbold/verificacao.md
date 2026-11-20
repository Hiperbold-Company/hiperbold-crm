# Verificação no WSL (`verificar`)

Roda no servidor `hiperbold-homolog` (WSL do PC Windows) os testes pesados do CI do GitHub e
grava o resultado no commit como status `verificar/wsl`. Não pesa no Mac e não usa runner
self-hosted do GitHub (o repositório é público).

## Uso (do Mac)

```bash
bash hiperbold/scripts/verificar.sh <branch>                 # usa o verificar-remoto.sh da branch
bash hiperbold/scripts/verificar.sh <branch> --script-local  # usa o verificar-remoto.sh deste checkout
bash hiperbold/scripts/verificar.test.sh                     # teste do comando, sem servidor
```

- A branch precisa estar no GitHub (push antes). O clone `~/verificacao/hiperbold-crm` vai para
  `origin/<branch>` com `reset --hard` e `clean` (sem `-x`, o `node_modules` fica): é só da
  verificação. Se não existir, é clonado do GitHub.
- A rodada leva mais de meia hora. Uma por vez (trava em `~/verificacao/.verificar.lock`).

## O que roda

| Etapa | Comando |
|---|---|
| install | `pnpm install --frozen-lockfile` (pnpm de `packageManager`, pelo corepack) |
| typecheck | `pnpm typecheck` com `NODE_OPTIONS=--max-old-space-size=8192` |
| lint | `pnpm lint` |
| unit | `pnpm test:unit` (a suíte inteira) |
| db | `pnpm test:db` (Postgres efêmero próprio em `127.0.0.1:16500`) |

- Cada etapa vale pelo exit code. Falha no install pula o resto; as demais rodam todas.
- Logs: `~/verificacao/logs/<sha>/<etapa>.log` e `resumo.txt` (tempos e primeira linha de erro).
- Status: `success` ou `failure` com as etapas que falharam, publicado pelo `gh` do WSL.
- Portas: prévia + 100 (banco 16500; 3590 reservada ao e2e). Porta ocupada: para e não derruba nada.

## O que não roda

- **e2e**: o `e2e.yml` usa portas fixas que neste servidor já têm dono (Supabase do repo em
  54320-54329, com 54321-54323 ocupadas por containers antigos e o projeto `deskcomm-crm` antigo;
  WAHA na 3000; dublês em 3001, 3995-3999 e 8079). Um `success` aqui não prova tela nenhuma.
- O resto que o CI roda a mais: `test:db:update`, a perna do Postgres 17, `test:shell`, cercas,
  `lint:channels`, `lint:role-rank`, colisão de migration e `imagens-ok`.
