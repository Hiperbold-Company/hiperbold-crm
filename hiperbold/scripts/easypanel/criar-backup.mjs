// Cria (ou atualiza) o serviço `backup` no projeto do CRM no EasyPanel: imagem
// ghcr.io/hiperbold-company/hiperbold-crm-backup:latest (hiperbold/backup/), volume em
// /backups e as variáveis do rodar.sh. D-191, decisão do Filipe de 13/10/2026.
//
// De onde vem cada valor (nada é impresso, só os nomes):
//   - SUPABASE_DB_URL: `.env.production` da raiz do projeto;
//   - token do Drive, ID da pasta e chave PÚBLICA age: `~/.claude/hipercrm.env`
//     (HIPERCRM_BACKUP_RCLONE_DRIVE_TOKEN, HIPERCRM_BACKUP_DRIVE_FOLDER_ID,
//     HIPERCRM_BACKUP_AGE_RECIPIENT). A chave PRIVADA nunca sai do Mac;
//   - credencial do registro (GHCR): a mesma do serviço `app`, que já baixa
//     imagem privada do GHCR.
//
// Uso: node hiperbold/scripts/easypanel/criar-backup.mjs            (só simula)
//      node hiperbold/scripts/easypanel/criar-backup.mjs --aplicar  (grava e publica)
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJETO, get, post } from './_api.mjs'

const SERVICO = 'backup'
const IMAGEM = 'ghcr.io/hiperbold-company/hiperbold-crm-backup:latest'
const aplicar = process.argv.includes('--aplicar')

const semAspas = (v) => v.trim().replace(/^["']|["']$/g, '')
function valorDe(caminho, chave) {
  const linha = readFileSync(caminho, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${chave}=`))
  if (!linha) throw new Error(`${chave} não está em ${caminho}`)
  const valor = semAspas(linha.slice(chave.length + 1))
  if (!valor) throw new Error(`${chave} está vazia em ${caminho}`)
  return valor
}

async function rest(metodo, caminho, corpo) {
  const linhas = readFileSync(join(homedir(), '.claude', '.env'), 'utf8').split(/\r?\n/)
  const g = (k) => semAspas((linhas.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1))
  const base = (process.env.EASYPANEL_HIPERBOLD_URL ?? g('EASYPANEL_HIPERBOLD_URL')).replace(/\/$/, '')
  const chave = process.env.EASYPANEL_HIPERBOLD_API_KEY ?? g('EASYPANEL_HIPERBOLD_API_KEY')
  const r = await fetch(`${base}/api${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  const texto = await r.text()
  let json = null
  try { json = JSON.parse(texto) } catch { /* corpo vazio no POST */ }
  return { status: r.status, corpo: json }
}

const raiz = new URL('../../../', import.meta.url).pathname
const segredosDoCrm = join(homedir(), '.claude', 'hipercrm.env')
const variaveis = {
  SUPABASE_DB_URL: valorDe(join(raiz, '.env.production'), 'SUPABASE_DB_URL'),
  AGE_RECIPIENT: valorDe(segredosDoCrm, 'HIPERCRM_BACKUP_AGE_RECIPIENT'),
  RCLONE_CONFIG_DRIVE_TOKEN: valorDe(segredosDoCrm, 'HIPERCRM_BACKUP_RCLONE_DRIVE_TOKEN'),
  RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID: valorDe(segredosDoCrm, 'HIPERCRM_BACKUP_DRIVE_FOLDER_ID'),
  TZ: 'America/Sao_Paulo',
  HORA_DO_BACKUP: '12:30',
  RETENCAO_DRIVE_DIAS: '30',
  RETENCAO_LOCAL_DIAS: '7',
  RODAR_AO_INICIAR: '1',
}
if (!variaveis.AGE_RECIPIENT.startsWith('age1')) throw new Error('HIPERCRM_BACKUP_AGE_RECIPIENT não é chave pública age')
// O token é JSON numa linha só; o .env do EasyPanel aceita aspas simples.
const env = Object.entries(variaveis)
  .map(([k, v]) => (k === 'RCLONE_CONFIG_DRIVE_TOKEN' ? `${k}='${v}'` : `${k}=${v}`))
  .join('\n')

const dados = await get('projects.listProjectsAndServices', null)
const servicos = (dados?.services ?? []).filter((s) => s.projectName === PROJETO)
const app = servicos.find((s) => s.name === 'app')
const existe = servicos.some((s) => s.name === SERVICO)
if (!app?.source?.username || !app?.source?.password) throw new Error('o serviço app não tem credencial de registro para reaproveitar')

console.info(`projeto ${PROJETO}, serviço ${SERVICO}: ${existe ? 'já existe, será atualizado' : 'será criado'}`)
console.info(`imagem ${IMAGEM} com a credencial de registro do app`)
console.info(`variáveis: ${Object.keys(variaveis).join(', ')}`)
console.info('volume: backups -> /backups')
if (!aplicar) {
  console.info('simulação: nada foi gravado (use --aplicar)')
  process.exit(0)
}

const passos = []
if (!existe) passos.push(['createService', { projectName: PROJETO, serviceName: SERVICO }])
passos.push(
  ['updateSourceImage', { projectName: PROJETO, serviceName: SERVICO, image: IMAGEM, username: app.source.username, password: app.source.password }],
  ['updateEnv', { projectName: PROJETO, serviceName: SERVICO, env }],
)
for (const [acao, entrada] of passos) {
  const r = await post(`services.app.${acao}`, entrada)
  console.info(`${acao}: ${r.status}`)
  if (r.status >= 400) {
    // O corpo da resposta não é impresso: o EasyPanel pode ecoar a entrada, que
    // leva a senha do banco e o token do Drive.
    console.info('falhou; veja o serviço no painel do EasyPanel')
    process.exit(1)
  }
}
// Volume: a API tRPC não tem `updateMounts`; o EasyPanel expõe o volume pela API
// REST (`/api/listMounts` e `/api/createMount`, ver /api/openapi.json).
const montagens = await rest('GET', `/listMounts?projectName=${PROJETO}&serviceName=${SERVICO}`)
if (!(Array.isArray(montagens.corpo) && montagens.corpo.some((m) => m.mountPath === '/backups'))) {
  const r = await rest('POST', '/createMount', { projectName: PROJETO, serviceName: SERVICO, values: { type: 'volume', name: 'backups', mountPath: '/backups' } })
  console.info(`createMount: ${r.status}`)
  if (r.status >= 400) process.exit(1)
} else {
  console.info('volume /backups já existe')
}
const publicado = await post('services.app.deployService', { projectName: PROJETO, serviceName: SERVICO })
console.info(`deployService: ${publicado.status}`)
if (publicado.status >= 400) process.exit(1)
console.info('serviço publicado; a primeira rodada sai em seguida (RODAR_AO_INICIAR=1). Conferir o log do serviço e a pasta do Drive.')
