import { recortarValores, type LeitorDosCampos } from "@/lib/campos/recorte-por-papel";
import { cargoEEmpresa } from "@/lib/contacts/cargo-e-empresa";
import type { CampoDoCartao } from "@/lib/kanban/linhas-do-cartao";
import { linksParaExibir } from "@/lib/leads/links-de-contato";
import type { Lead } from "@/lib/types/leads";

type DadosDoContato = Pick<Lead, "contact_phone" | "contact_email" | "contact_links">;

/** A linha de `contacts` como o quadro a lê — as colunas que esta regra usa. */
export interface LinhaDoContatoNoQuadro {
  id: string;
  phone_number: string | null;
  email: string | null;
  custom_fields: Record<string, unknown> | null;
  is_anonymized: boolean | null;
}

/**
 * Anexa telefone, e-mail e links do CONTATO aos leads do quadro — o que o card
 * do funil mostra sem abrir o dossiê.
 *
 * PURA de propósito: recebe as linhas de contato que a etapa dos marcadores já
 * leu (`withMarcadoresDoContato`, na rota do quadro) em vez de consultar o
 * banco de novo. Uma leitura de `contacts` por quadro, não duas — e a regra
 * fica testável sem banco, já que um `route.ts` do Next só pode exportar os
 * métodos HTTP.
 *
 * Contato anonimizado (LGPD) é PULADO, mesmo que a linha ainda carregue algum
 * valor: o quadro é a superfície com mais exposição do produto, e "apagado a
 * pedido do titular" não pode reaparecer num card.
 *
 * Vazio não vira campo: só se escreve o que existe, para o payload não engordar
 * com três chaves nulas em todo card. Negócio sem contato (ou contato que não
 * veio na leitura) passa intacto — o card dele não pode sumir.
 */
export function anexarDadosDoContato(leads: Lead[], contatos: LinhaDoContatoNoQuadro[]): Lead[] {
  const porContato = new Map<string, DadosDoContato>();
  for (const contato of contatos) {
    if (contato.is_anonymized) continue;
    const links = linksParaExibir(contato.custom_fields);
    const dados: DadosDoContato = {
      ...(contato.phone_number ? { contact_phone: contato.phone_number } : {}),
      ...(contato.email ? { contact_email: contato.email } : {}),
      ...(links.length > 0 ? { contact_links: links } : {}),
    };
    if (Object.keys(dados).length > 0) porContato.set(contato.id, dados);
  }
  if (porContato.size === 0) return leads;

  return leads.map((lead) => {
    const dados = lead.contact_id ? porContato.get(lead.contact_id) : undefined;
    return dados ? { ...lead, ...dados } : lead;
  });
}

/**
 * Cargo e empresa do CONTATO, para as linhas do cartão ("Editar cartão").
 *
 * Separada de `anexarDadosDoContato` porque cargo e empresa NÃO são colunas:
 * moram em `contacts.custom_fields`, e campo personalizado pode ser restrito
 * (1015, `publico: false`). Por isso o `custom_fields` do contato passa por
 * `recortarValores` ANTES de `cargoEEmpresa`: o gerente não recebe o cargo que
 * só o administrador vê. A queda para o `custom_fields` do NEGÓCIO não é feita
 * aqui: o cliente a calcula sobre o `custom_fields` do lead, que já sai
 * recortado da rota.
 *
 * Só anexa o que o funil pôs no cartão (quem não configurou não paga payload),
 * e contato anonimizado (LGPD) é pulado, como em `anexarDadosDoContato`.
 */
export function anexarCargoEEmpresaDoContato(
  leads: Lead[],
  contatos: LinhaDoContatoNoQuadro[],
  opcoes: {
    linhas: readonly CampoDoCartao[];
    restritas: ReadonlySet<string>;
    leitor: LeitorDosCampos | null | undefined;
  },
): Lead[] {
  const querCargo = opcoes.linhas.includes("cargo");
  const querEmpresa = opcoes.linhas.includes("empresa");
  if (!querCargo && !querEmpresa) return leads;

  const porContato = new Map<string, Pick<Lead, "contact_cargo" | "contact_empresa">>();
  for (const contato of contatos) {
    if (contato.is_anonymized) continue;
    const campos = recortarValores(contato.custom_fields, opcoes.restritas, opcoes.leitor);
    const { cargo, empresa } = cargoEEmpresa(campos);
    const dados = {
      ...(querCargo && cargo ? { contact_cargo: cargo } : {}),
      ...(querEmpresa && empresa ? { contact_empresa: empresa } : {}),
    };
    if (Object.keys(dados).length > 0) porContato.set(contato.id, dados);
  }
  if (porContato.size === 0) return leads;

  return leads.map((lead) => {
    const dados = lead.contact_id ? porContato.get(lead.contact_id) : undefined;
    return dados ? { ...lead, ...dados } : lead;
  });
}
