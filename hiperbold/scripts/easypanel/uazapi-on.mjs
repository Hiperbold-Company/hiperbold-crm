// Liga o pareamento do WhatsApp por QR Code em produção (D-187): acrescenta ao serviço `app`
// o endereço do servidor UAZAPI da Hiperbold e o token de administrador, e republica o serviço.
// As duas variáveis precisam vir da mesma origem (as duas no ambiente), senão o CRM recusa.
//
// Uso: node hiperbold/scripts/easypanel/uazapi-on.mjs            (simulação: nada é enviado)
//      node hiperbold/scripts/easypanel/uazapi-on.mjs --aplicar  (grava e republica)
// AÇÃO EM PRODUÇÃO (variável nova e novo deploy): só com autorização do Filipe.
import { PROJETO, post, servicosDoCrm, valorDoEnvGlobal } from './_api.mjs'

const SERVIDOR = 'https://hiperbold.uazapi.com'

async function principal() {
  // No arquivo global as chaves da UAZAPI são minúsculas: `server_url` e `admin_token`.
  const servidor = valorDoEnvGlobal('server_url').replace(/\/$/, '')
  const token = valorDoEnvGlobal('admin_token')
  if (servidor !== SERVIDOR || token.length < 10) return 'servidor ou token inesperado no arquivo global'

  const app = (await servicosDoCrm()).find((s) => s.nome === 'app')
  if (!app) return 'serviço app não encontrado'
  const jaExistem = app.linhas.filter((l) => /^UAZAPI_(SERVIDOR_URL|ADMIN_TOKEN)=/.test(l)).map((l) => l.split('=')[0])
  if (jaExistem.length) return `já existem: ${jaExistem.join(', ')}`

  const semFimVazio = app.linhas.filter((l, i) => !(i === app.linhas.length - 1 && l === ''))
  const novo = [...semFimVazio, `UAZAPI_SERVIDOR_URL=${servidor}`, `UAZAPI_ADMIN_TOKEN=${token}`].join('\n') + '\n'
  console.info('variáveis antes', semFimVazio.length, 'depois', semFimVazio.length + 2)

  if (process.argv[2] !== '--aplicar') {
    console.info('simulação: nada enviado')
    return null
  }
  const gravou = await post('services.app.updateEnv', { projectName: PROJETO, serviceName: 'app', env: novo })
  console.info('updateEnv', gravou.status, gravou.inicio)
  if (gravou.status !== 200) return 'updateEnv falhou, deploy não disparado'
  const publicou = await post('services.app.deployService', { projectName: PROJETO, serviceName: 'app' })
  console.info('deployService', publicou.status, publicou.inicio)
  return null
}

const erro = await principal()
if (erro) {
  console.info(erro)
  process.exitCode = 1
}
