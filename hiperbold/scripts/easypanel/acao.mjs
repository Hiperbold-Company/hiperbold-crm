// Para ou religa um serviço do CRM no EasyPanel. Usado na publicação com migration: o
// agendador fica parado enquanto o `prod-schema.sh` roda, para não disputar trava com os crons.
// Uso: node hiperbold/scripts/easypanel/acao.mjs <stopService|startService> <servico>
// AÇÃO EM PRODUÇÃO: só a sessão principal, com autorização do Filipe.
import { PROJETO, post } from './_api.mjs'

const ACOES = ['stopService', 'startService']
const [acao, servico] = process.argv.slice(2)
if (!ACOES.includes(acao) || !servico) {
  console.info(`uso: acao.mjs <${ACOES.join('|')}> <servico>`)
  process.exitCode = 1
} else {
  const r = await post(`services.app.${acao}`, { projectName: PROJETO, serviceName: servico })
  console.info(acao, servico, r.status, r.inicio)
}
