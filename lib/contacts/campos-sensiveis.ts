/**
 * Chave de campo personalizado que lembra DOCUMENTO PESSOAL: nunca sai na exportação, nunca é
 * oferecida nem aceita como filtro. É lista de bloqueio por nome — o CPF de verdade mora em
 * colunas próprias (cifrado) que nenhuma consulta daqui lê; isto cobre quem o gravou como campo
 * livre (importação de planilha, integração).
 *
 * Casa: `cpf`, `cnpj`, `cpf_cnpj`, `documento`, `rg` (só como palavra: `rg`, `rg_numero`,
 * `numero_rg` — `cargo` não é RG), `passaporte`.
 */
const SENSIVEL = /cpf|cnpj|documento|passaporte|(^|[^a-z])rg($|[^a-z])/i;

export function chaveSensivelDeCampo(chave: string): boolean {
  return SENSIVEL.test(chave);
}
