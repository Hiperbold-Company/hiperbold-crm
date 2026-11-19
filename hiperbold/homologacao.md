# Homologação (prévia) do Hiperbold CRM

Prévia de uma branch no servidor `hiperbold-homolog` (WSL do PC Windows), com banco próprio e
dados de exemplo. Nunca usa dado nem chave da produção.

## Uso (do Mac)

```bash
bash hiperbold/scripts/homologar.sh <branch>              # sobe ou atualiza a prévia
bash hiperbold/scripts/homologar.sh <branch> --zerar      # recria o banco da prévia do zero
bash hiperbold/scripts/homologar.sh <branch> --script-local  # usa o homologar-remoto.sh deste checkout
```

- A branch precisa estar no GitHub (push antes). O clone `~/homologacao/hiperbold-crm` vai para
  `origin/<branch>` com `reset --hard` e `clean`: é só da homologação, mudança local nele se perde.
- A parte remota (`hiperbold/scripts/homologar-remoto.sh`) roda a versão **da própria branch**.
  Branch sem o script, ou teste do script antes do push: `--script-local`.
- Rodar de novo atualiza código e schema sem apagar dados: o `supabase/baseline.sql` é reaplicado
  em modo update (sem `ON_ERROR_STOP`, como o `update.sh`). Banco novo usa modo install.
- Uma rodada por vez (trava em `~/homologacao/.homologar.lock`).

## O que sobe

| Peça | Onde |
|---|---|
| App, APIs do Supabase (mesma origem, via Caddy) | `127.0.0.1:3490` |
| Postgres da prévia | `127.0.0.1:16400` (usuário/senha padrão da CLI: `postgres`) |
| Kong do Supabase (direto) | `127.0.0.1:55321` |
| worker, scheduler, Redis, SRH | sem porta no host |

- Supabase pela CLI `supabase@2.117.0`, projeto `hiperbold-homolog`, workdir `~/homologacao/supabase`
  (não usa o `config.toml` do repo, que é do projeto antigo `deskcomm-crm`). A rede Docker
  `hiperbold-homolog` tem `host_binding_ipv4=127.0.0.1`: nada sai do loopback do WSL.
- Imagens `hiperbold-homolog-{app,worker,scheduler,ferramentas}` construídas no WSL a partir do clone.
- Sem WAHA: WhatsApp, e-mail, pagamento e IA ficam sem provedor (nenhum envio real).
- Porta ocupada por outro processo: o script para e não derruba nada. Só para teste,
  `HOMOLOG_PORTA_WEB=<porta>` troca a porta do app.
- Reservadas, não usar: 3500 e 16500.

## Dados de exemplo

"Clínica Demonstração" (`scripts/demo-site/02-org.sql` e `03-dados.sql`): equipe de 4 pessoas,
funil de clínica, contatos, negócios, conversas e mensagens fictícios. A dona (Juliana Ferraz) é
garantida pelo `scripts/bootstrap-owner.ts`, como no `install.sh`: admin da organização e
super-admin.

## Arquivos no WSL (fora do clone)

| Arquivo | Conteúdo |
|---|---|
| `~/homologacao/credenciais.txt` (600) | endereço e senhas de teste da dona e da equipe |
| `~/homologacao/.env.homolog` (600) | segredos de teste gerados uma vez; `HOMOLOG_ORIGEM` |
| `~/homologacao/runtime/` | compose, Caddyfile e `app.env`, regerados a cada rodada |
| `~/homologacao/logs/` | log de cada rodada |

## Endereço público

`HOMOLOG_ORIGEM` vazio = `http://127.0.0.1:3490` (Windows, ou do Mac com
`ssh -L 3490:127.0.0.1:3490 filipe@hiperbold-homolog`). Quando o túnel publicar
`previa-crm.hiperbold.com.br`, ponha `HOMOLOG_ORIGEM=https://previa-crm.hiperbold.com.br` no
`.env.homolog` e rode de novo (o Supabase reinicia sozinho para o Auth aceitar a origem nova, dados mantidos): o navegador fala com app e Supabase por essa origem.

## Desligar

```bash
ssh filipe@hiperbold-homolog 'docker compose -f ~/homologacao/runtime/compose.yml down && cd ~/homologacao/supabase && npx --yes supabase@2.117.0 stop --workdir ~/homologacao/supabase'
```

`stop` sem `--no-backup` guarda o banco; a próxima rodada o reaproveita.
