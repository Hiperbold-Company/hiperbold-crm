# DeskcommCRM · fork da Hiperbold

Este é o fork `hiperbold/hiperbold-crm` do projeto `melgarafael/DeskcommCRM` (MIT). A doutrina do autor continua valendo e mora em `CLAUDE.md` e `AGENTS.md` na raiz: **esses dois arquivos não são editados aqui**, para puxar as atualizações do autor sem conflito. Tudo o que é específico da Hiperbold fica nesta pasta.

- Pendências: [`DEBITO.md`](DEBITO.md)
- Produção: https://crm.hiperbold.com.br

## Fluxo de trabalho

1. Desenvolver em `~/projects/hiperbold-crm`, na branch `feat/planos-assinatura` (commit e push nela são livres, não publicam nada).
2. Abrir PR para a `main` do fork (`gh pr create -R hiperbold/hiperbold-crm`) e esperar `ci`, `e2e` e `perf` verdes. Depois de cada push na `main` o PR fecha sozinho: a próxima publicação pede PR novo.
3. Se a publicação leva migration: backup (`hiperbold/scripts/backup-prod.sh`), parar o agendador (`node hiperbold/scripts/easypanel/acao.mjs stopService scheduler`), `hiperbold/scripts/prod-schema.sh` com a árvore limpa, religar o agendador (`startService`).
4. `bash hiperbold/scripts/varredura-de-segredos.sh` e então `git push origin <sha>:main`. O GitHub Actions (`.github/workflows/publish-image.yml`) compila e publica três imagens: `ghcr.io/hiperbold/deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler`.
5. O fluxo "Deploy no EasyPanel (Hiperbold)" (`.github/workflows/deploy-easypanel.yml`) dispara quando as imagens ficam prontas, espera `ci` e `e2e` verdes da `main` e só então manda o EasyPanel (projeto `hiperbold-crm-1`) baixar a imagem e reiniciar. Se o `e2e` da `main` precisar ser rerodado, rerodar também a rodada do Deploy (`gh run rerun <id> -R hiperbold/hiperbold-crm`).
6. Conferir `https://crm.hiperbold.com.br/api/v1/health`: o campo `version` tem de ser o commit publicado.

Push na `main` é deploy de produção: só com a verificação completa verde e autorização do Filipe em vigor.

**A VPS nunca compila código.** Build na VPS já derrubou os outros serviços, e o build do Next pede 4 GB.

## Desenvolvimento local (WSL)

Portas: app **3300**, ponte do Redis **8090**, Supabase local **54321** (API), **54322** (banco), **54323** (Studio), **54324** (caixa de e-mails de teste). A 3000 é do site da Unique no WSL, e a 3200 e a 3201 são de programas Node no Windows (o WSL enxerga as portas do Windows).

```bash
cd ~/projects/hiperbold-crm
pnpm install

# 1ª vez, ou para zerar o banco local (APAGA os dados locais)
bash hiperbold/scripts/supabase-local.sh
# nas outras vezes basta: npx supabase@2.117.0 start   (a pasta de migrations precisa sair do caminho só num banco novo)

bash hiperbold/scripts/dev-env.sh          # gera .env.local (não sobrescreve)
docker compose -f hiperbold/docker-compose.dev.yml --env-file .env.local up -d
pnpm dev -p 3300 -H 0.0.0.0                # app
pnpm worker                                # agente de IA 24/7, em outro terminal
pnpm dev:crons                             # crons, em outro terminal
```

Conferir: `curl http://localhost:3300/api/v1/health`.

Testes unitários no WSL: `bash hiperbold/scripts/test-unit.sh` (roda `pnpm test:unit` nas condições do CI; direto, o Redis de dev e a rede espelhada do WSL dão falsos vermelhos).

## No Mac e na nuvem (desde 13/10/2026)

Regra do Filipe, de 13/10/2026: nuvem antes do Mac. É preferência, não obrigação; o que for necessário localmente pode ser instalado.

- **No Mac roda o ambiente completo** (decisão de 13/10/2026, por ser o projeto principal): os comandos de "Desenvolvimento local" valem iguais, com o Docker do OrbStack, e a senha do administrador local fica em `~/github-projects/hiperbold-crm-data.md`.
- **Dependências:** `pnpm install` (1 GB). O pnpm da máquina troca sozinho para o 9.15.9 do `packageManager` e o Node 24 atende o `>=22` do projeto: o Node 22 não foi instalado. Serve para editar e rodar os portões que não pedem Docker: `typecheck`, `lint`, `lint:channels`, `cercas` e `test-unit.sh`. Vermelhos esperados no Mac, que não são defeito de código: os 11 testes de `instalador-idioma-da-cli` (o bash do macOS é o 3.2 e o `_i18n.sh` pede 4.4 ou mais novo) e os 2 do Asaas quando o `.env.local` fica no lugar.
- **No GitHub**, sem custo porque o repositório é público: `ci`, `e2e` e `perf` rodam em cada PR o que pede banco (`test:db`), ponta a ponta e build. É a verificação completa antes de publicar.
- **Reserva na nuvem, ainda não validada:** GitHub Codespaces, sob demanda, pelo `.devcontainer/devcontainer.json` (Node 22, pnpm 9.15.9, Docker), para quando o Mac não estiver à mão.

```bash
gh auth refresh -h github.com -s codespace     # uma vez só, abre o navegador (quem faz é o Filipe)
gh codespace create -R hiperbold/hiperbold-crm -b feat/planos-assinatura -m standardLinux32gb
gh codespace ssh -c <nome>                     # dentro: os comandos de "Desenvolvimento local", na mesma ordem
gh codespace ports forward 3300:3300 54321:54321 -c <nome>   # abre http://localhost:3300 no Mac
gh codespace stop -c <nome>                    # sempre ao terminar: parado não gasta horas
```

A conta pessoal gratuita tem uma cota mensal de horas e de disco do Codespaces (cerca de 30 horas na máquina de 4 núcleos); conferir o consumo em github.com/settings/billing antes de pensar em plano pago. Nenhum segredo de produção entra no Codespace: o `dev-env.sh` gera lá um `.env.local` com chaves aleatórias, e a senha do administrador local fica em `~/hiperbold-crm-data.md` dentro dele.

## Produção

- Banco: Supabase Cloud, região São Paulo. Piloto no plano Free; Pro antes de entrar dado de cliente real.
- Serviços no EasyPanel com o mesmo nome curto do `docker-compose.prod.yml` do autor, porque o nome curto é o endereço interno: `redis`, `srh`, `waha`, `app`, `worker`, `scheduler`.
- Schema: o deploy só troca a imagem. Código que depende de coluna nova exige, ANTES do push, `bash hiperbold/scripts/prod-schema.sh` (re-aplica o `baseline.sql` idempotente e garante a chave de cifra).
- Backup: `hiperbold/scripts/backup-prod.sh`, diário pela tarefa do Windows `HiperboldCRM-BackupBanco`, em `D:\Hiperbold\backups\hiperbold-crm` (30 dias). Restaurar num projeto Supabase novo: `pg_restore --no-owner --no-privileges -d <url> <arquivo>.dump`.
- Backup diário (serviço `backup` no EasyPanel): imagem `ghcr.io/hiperbold/hiperbold-crm-backup:latest` (código em `hiperbold/backup/`, montada pelo workflow `backup-image.yml`). Todo dia na `HORA_DO_BACKUP` faz dois `pg_dump` (`public`+`auth`, e `private` em arquivo à parte), valida com `pg_restore --list` (mínimo 50 tabelas), cifra com `age` e envia os dois `.age` à pasta do Google Drive; recusa rodar sem `AGE_RECIPIENT`, nunca envia em claro.
  - Variáveis: `SUPABASE_DB_URL`, `AGE_RECIPIENT` (chave pública `age1...`), `RCLONE_CONFIG_DRIVE_TOKEN` (JSON do OAuth), `RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID` (ID da pasta do Drive); opcionais `HORA_DO_BACKUP` (12:30), `TZ` (America/Sao_Paulo), `RETENCAO_LOCAL_DIAS` (7), `RETENCAO_DRIVE_DIAS` (30), `PASTA_LOCAL` (/backups), `RODAR_AO_INICIAR` (1 faz uma rodada assim que o serviço sobe). Monte um volume em `/backups`. Criar ou atualizar o serviço: `node hiperbold/scripts/easypanel/criar-backup.mjs` (sem `--aplicar` só simula).
  - Rodar uma vez, para testar: no terminal do serviço, `rodar.sh agora` (sai com 0 ou erro; a linha final é `backup ok: ...`, a de falha começa com `BACKUP FALHOU:`).
  - Onde ficam: Drive (pasta pelo ID, 30 dias) e volume local (7 dias). Teste sem rede: `bash hiperbold/backup/teste-rodar.sh`.
  - Restaurar: baixar os dois `.age` do Drive, `age -d -i <chave-privada> -o x.dump x.dump.age` (idem para o `-private`), e `pg_restore --no-owner --no-privileges -d <url> x.dump`. A chave privada nunca fica no serviço.
- Segredos de produção: `.env.production` no WSL (fora do Git, só leitura do usuário). Nunca no chat, nunca em commit.

## Portões antes de abrir PR

```bash
NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck
pnpm lint && pnpm lint:channels
bash hiperbold/scripts/test-unit.sh      # com o .env.local fora do caminho (mover e devolver no fim), como no GitHub
pnpm cercas                              # as cercas estruturais não rodam no test:unit (D-190)
pnpm test:db                             # precisa do Supabase local no ar
NODE_OPTIONS=--max-old-space-size=8192 pnpm build
```

Falhas conhecidas que não são defeito de código: D-081 (dois testes do autor que dependem do ambiente) e D-189 (limite do Docker Hub no GitHub).

## Scripts de produção

Todos leem a credencial de arquivo fora do Git e nunca imprimem valor.

- `hiperbold/scripts/prod-leitura.sh "<sql>"` ou `-f arquivo.sql`: consulta somente leitura no banco de produção.
- `hiperbold/scripts/easypanel/nomes.mjs [filtro]`: nomes das variáveis de cada serviço no EasyPanel (só leitura).
- `hiperbold/scripts/easypanel/acao.mjs <stopService|startService> <servico>`: parar e religar serviço.
- `hiperbold/scripts/easypanel/uazapi-on.mjs [--aplicar]`: liga o pareamento por QR em produção (D-187); sem o parâmetro só simula.

Os de `easypanel/` leem `EASYPANEL_HIPERBOLD_URL` e `EASYPANEL_HIPERBOLD_API_KEY` do ambiente ou do arquivo de segredos global da máquina (`~/.claude/.env`; no WSL, apontar com `HIPERBOLD_ENV=/mnt/c/...`).

## Regras e decisões do fork

`AGENTS.md` e `CLAUDE.md` da raiz são do autor e não são editados aqui; as regras da Hiperbold para este projeto ficam nesta seção.

- **Nome para o cliente:** principal "Hiperbold CRM" (telas, documentos, central de ajuda), secundário "HiperCRM" (e-mails e mensagens leves). "DeskcommCRM" nunca aparece para o cliente.
- **Canais:** WhatsApp só pela UAZAPI (o cliente conecta lendo o QR dentro do CRM; a instância é criada no servidor UAZAPI da Hiperbold) e pela API oficial da Meta. Instagram e Messenger só pela rota oficial, com o app da Meta do próprio CRM, sem serviço intermediário (D-186).
- **Limite de Conexões:** Pro 3, Max 10, Scale 20, somando WhatsApp, Instagram e Messenger, e bloqueia de verdade, independente do modo de bloqueio dos outros itens.
- **Preço não se inventa:** valor, desconto e parcela vêm do Filipe.
- **Teste não se enfraquece:** prova vermelha se resolve na causa, nunca afrouxando a prova.
- **Toda pendência vai para o `DEBITO.md`**, inclusive as que dependem do Filipe.
- **Segredo nunca no chat nem em commit:** não listar chave nem valor, não ler `.env.local` nem `.env.production` com `cat` ou `grep` que imprima valor.
- **Banco local:** nunca `supabase db reset`; o `hiperbold/scripts/supabase-local.sh` só serve para banco NOVO (apaga os dados locais).
- **Produção:** deploy, `prod-schema.sh`, EasyPanel e banco real só pela sessão principal, nunca por sub-agente. Variável nova de produção e ação destrutiva no banco pedem confirmação do Filipe.
- **GitHub:** o `gh` dentro do repositório resolve para o remoto do autor; sempre passar `-R hiperbold/hiperbold-crm`. Fluxos agendados herdados do autor ficam desligados no fork (D-192).
- **Texto:** português do Brasil, sem travessão.

## Em outra máquina (migração para o Mac, 10/2026)

- Clonar `hiperbold/hiperbold-crm`, acrescentar o remoto `upstream` (`melgarafael/DeskcommCRM`), Node 22 e pnpm 9.15.9, Docker no ar.
- Fora do Git e preciso levar: `.env.production` e `.env.local` da raiz do projeto, o arquivo de segredos global e o `hipercrm.env` da pasta `~/.claude` (app da Meta do CRM).
- Banco local: é de desenvolvimento e pode nascer do zero (`hiperbold/scripts/supabase-local.sh`, depois `dev-env.sh` e `dev-owner.sh`). Não há dado de cliente nele.
- Os scripts foram escritos para o WSL: o padrão de pasta do `backup-prod.sh` aponta para o disco D do Windows (passar a pasta como argumento). A rotina diária de backup não vai para o Mac: decisão de 13/10/2026, a solução será no EasyPanel (D-191).
- No Mac, feito em 13/10/2026: ver a seção "No Mac e na nuvem".
- O ponto de retomada está no topo de [`status.md`](status.md).

## O que é só do fork

- Conexões MCP dos agentes (IA › Ensinar o agente › Conexões MCP): código em `lib/ai/mcp-externo/` e `lib/agent-engine/edge/crm/mcp-externo-tools.ts`, tabela `ai_mcp_connections` (migration 0901, faixa 09xx reservada ao fork). Plano e decisões em `planos/2026-09-19-conexoes-mcp.md`. Fluxo de teste no n8n registrado em `status.md`.

## Puxar atualizações do autor

```bash
bash hiperbold/scripts/conferir-upstream.sh   # quanto o autor andou, o que é nosso nos arquivos dele, e se o merge conflita
git merge upstream/main
```

Conflito só deve aparecer em arquivo que a Hiperbold alterou fora desta pasta. Antes de alterar arquivo do autor, pesar se não cabe como configuração.
