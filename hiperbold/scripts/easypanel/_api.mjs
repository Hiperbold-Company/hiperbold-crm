// Acesso à API do EasyPanel da Hiperbold, comum aos scripts desta pasta.
//
// Credencial: EASYPANEL_HIPERBOLD_URL e EASYPANEL_HIPERBOLD_API_KEY, lidas do ambiente ou,
// na falta, do arquivo de segredos global da máquina (`~/.claude/.env`, ou o caminho em
// HIPERBOLD_ENV). Nenhum script daqui imprime valor de variável: só nome e tamanho.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROJETO = 'hiperbold-crm-1'

const semAspas = (v) => v.trim().replace(/^["']|["']$/g, '')

/** Linhas `chave=valor` do arquivo de segredos global, na ordem em que aparecem. */
export function linhasDoEnvGlobal() {
  const caminho = process.env.HIPERBOLD_ENV ?? join(homedir(), '.claude', '.env')
  return readFileSync(caminho, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), semAspas(l.slice(l.indexOf('=') + 1))])
}

/** Valor de uma chave do arquivo global. Chave repetida só vale se todas as cópias forem iguais. */
export function valorDoEnvGlobal(chave) {
  const valores = [...new Set(linhasDoEnvGlobal().filter(([k]) => k === chave).map(([, v]) => v))]
  if (valores.length !== 1) throw new Error(`${chave}: esperava um valor único, achei ${valores.length}`)
  return valores[0]
}

function credencial() {
  const url = process.env.EASYPANEL_HIPERBOLD_URL ?? valorDoEnvGlobal('EASYPANEL_HIPERBOLD_URL')
  const chave = process.env.EASYPANEL_HIPERBOLD_API_KEY ?? valorDoEnvGlobal('EASYPANEL_HIPERBOLD_API_KEY')
  return { url: url.replace(/\/$/, ''), cabecalhos: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' } }
}

export async function get(procedimento, entrada) {
  const { url, cabecalhos } = credencial()
  const r = await fetch(`${url}/api/trpc/${procedimento}?input=${encodeURIComponent(JSON.stringify({ json: entrada }))}`, { headers: cabecalhos })
  const corpo = await r.json()
  return corpo?.result?.data?.json ?? corpo?.json ?? null
}

export async function post(procedimento, entrada) {
  const { url, cabecalhos } = credencial()
  const r = await fetch(`${url}/api/trpc/${procedimento}`, { method: 'POST', headers: cabecalhos, body: JSON.stringify({ json: entrada }) })
  return { status: r.status, inicio: (await r.text()).slice(0, 120) }
}

/** Serviços do projeto do CRM, com o `env` de cada um quebrado em linhas. */
export async function servicosDoCrm() {
  const dados = await get('projects.listProjectsAndServices', null)
  if (!dados) throw new Error('o EasyPanel não devolveu a lista de serviços')
  return (dados.services ?? [])
    .filter((s) => s.projectName === PROJETO)
    .map((s) => ({ nome: s.name, linhas: String(s.env ?? '').split('\n') }))
}
