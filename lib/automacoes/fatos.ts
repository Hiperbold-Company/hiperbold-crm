/**
 * Os FATOS que uma automação lê a cada passo: o contato, o negócio da execução,
 * os negócios do contato e as variáveis guardadas. Dados puros — quem carrega é
 * o adaptador do motor (`engine.ts` → `loadFatosDaAutomacao`), quem lê são as
 * condições (`condicoes.ts`), as operações de campo e o `renderTemplate`.
 *
 * Lidos AO VIVO em cada passo (nunca congelados no início da execução): um
 * bloco que acabou de mudar a etapa tem de ver a etapa nova no bloco seguinte.
 */

import type { AnuncioDoFluxo } from "./anuncio-do-contato";
import type { JanelaDaConversa } from "./conversa-de-whatsapp";

export interface ContatoDosFatos {
  id: string;
  name: string | null;
  email: string | null;
  phone_number: string | null;
  birthdate: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  /**
   * O anúncio de primeiro toque (`{{contact.anuncio.*}}`, `anuncio-do-contato.ts`).
   * Opcional só para os montadores de fatos que não o carregam; quem carrega
   * sempre o preenche, com string vazia onde não há anúncio.
   */
  anuncio?: AnuncioDoFluxo;
  /**
   * O vendedor dono do cliente (`contacts.carteira_user_id`), `null` sem carteira.
   * Só leitura: quem grava é `fn_definir_carteira_do_cliente`. Opcional só para os
   * montadores de fatos que não o carregam — ausente é "não lido", nunca "sem dono".
   */
  carteira_user_id?: string | null;
}

export interface NegocioDosFatos {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  status: string;
  value_cents: number | null;
  owner_user_id: string | null;
  source: string;
  tags: string[];
  expected_close_date: string | null;
  custom_fields: Record<string, unknown>;
}

export interface FatosDaAutomacao {
  contato: ContatoDosFatos | null;
  /** O negócio DA EXECUÇÃO: `vars._lead_id`, ou o aberto mais recente do contato. */
  negocio: NegocioDosFatos | null;
  /** Todos os negócios do contato (só o necessário às condições de negócio). */
  negocios: Array<{ id: string; pipeline_id: string; stage_id: string; status: string }>;
  /** `followup_enrollments.vars` desta execução. */
  vars: Record<string, unknown>;
  /**
   * A janela de 24h da conversa de WhatsApp do contato (`conversa-de-whatsapp.ts`).
   * Só é carregada quando o passo é uma condição que pergunta por ela; ausente
   * nos demais passos e nos montadores que não a carregam.
   */
  janela?: JanelaDaConversa;
  /**
   * 1015: as chaves (minúsculas) dos campos NÃO PÚBLICOS da organização, que o texto renderizado
   * (que pode sair ao cliente) nunca preenche. `"todas"` = não deu para ler quais são: nenhum campo
   * personalizado vira texto. As CONDIÇÕES continuam lendo `custom_fields` inteiro. Quem carrega os
   * fatos do banco sempre preenche; ausente só em fatos montados à mão sem campo restrito.
   */
  camposRestritos?: string[] | "todas";
}

/** Os fatos têm algum valor de campo personalizado (contato ou negócio da execução)? */
export function fatosTemCamposPersonalizados(f: Pick<FatosDaAutomacao, "contato" | "negocio">): boolean {
  return [f.contato?.custom_fields, f.negocio?.custom_fields].some((c) => !!c && Object.keys(c).length > 0);
}

/** O id do negócio que a execução carrega (o gatilho trouxe, ou um bloco criou/moveu). */
export function negocioDaExecucao(vars: Record<string, unknown>): string | null {
  const id = vars._lead_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
