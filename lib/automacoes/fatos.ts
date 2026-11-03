/**
 * Os FATOS que uma automação lê a cada passo: o contato, o negócio da execução,
 * os negócios do contato e as variáveis guardadas. Dados puros — quem carrega é
 * o adaptador do motor (`engine.ts` → `loadFatosDaAutomacao`), quem lê são as
 * condições (`condicoes.ts`), as operações de campo e o `renderTemplate`.
 *
 * Lidos AO VIVO em cada passo (nunca congelados no início da execução): um
 * bloco que acabou de mudar a etapa tem de ver a etapa nova no bloco seguinte.
 */

export interface ContatoDosFatos {
  id: string;
  name: string | null;
  email: string | null;
  phone_number: string | null;
  birthdate: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
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
}

/** O id do negócio que a execução carrega (o gatilho trouxe, ou um bloco criou/moveu). */
export function negocioDaExecucao(vars: Record<string, unknown>): string | null {
  const id = vars._lead_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
