// Lista os NOMES das variáveis de ambiente de cada serviço do CRM no EasyPanel. Só leitura,
// e nunca o valor. Uso: node hiperbold/scripts/easypanel/nomes.mjs [filtro]
// O filtro é uma expressão regular sobre o nome (ex.: "UAZAPI|ASAAS|SMTP").
import { servicosDoCrm } from './_api.mjs'

const filtro = new RegExp(process.argv[2] ?? '.', 'i')
for (const servico of await servicosDoCrm()) {
  const nomes = servico.linhas.filter((l) => l.includes('=')).map((l) => l.slice(0, l.indexOf('=')))
  console.info(servico.nome, `(${nomes.length})`, nomes.filter((n) => filtro.test(n)).join(' '))
}
