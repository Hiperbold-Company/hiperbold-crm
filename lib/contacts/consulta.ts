/**
 * A consulta de contatos que TODA superfície compartilha: a lista, a contagem
 * ("selecionar todos os N do filtro"), a exclusão em lote e a exportação.
 *
 * Existe para que o conjunto que a tela mostra, o que se apaga e o que se exporta
 * seja o MESMO por construção — e não "parecido", que é como se apaga o contato
 * errado. Quem quiser um filtro novo acrescenta aqui, uma vez.
 *
 * ─── Segurança ──────────────────────────────────────────────────────────────
 *  - Nenhum SQL é montado com texto do usuário. Tudo passa pelos operadores do
 *    PostgREST (`eq`, `ilike`, `contains`, `gte`, `lt`), que parametrizam o valor.
 *  - A chave de campo personalizado vira caminho JSON (`custom_fields->>chave`) e
 *    por isso é revalidada AQUI por `CHAVE_DE_CAMPO_FILTRAVEL`, mesmo já tendo
 *    passado pelo Zod: esta função é chamada também com objeto montado em código.
 *  - `%` e `_` do valor digitado são escapados: "50%" procura "50%", não "50" e
 *    qualquer coisa.
 *  - Funil/etapa/campo-de-negócio entram por JUNÇÃO (`!inner`) na tabela de
 *    negócios, com `organization_id` conferido na própria junção. Sem lista de ids
 *    no meio — uma base de 6.000 contatos estouraria a URL.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { hashCpf } from "@/lib/contacts/cpf";
import { idsPorHashDeCpf } from "@/lib/contacts/cpf-do-contato";
import { intervaloEmInstantes, periodoDoFiltro } from "@/lib/contacts/filtros";
import { CHAVE_DE_CAMPO_FILTRAVEL, type FiltrosDeContatos } from "@/lib/schemas/contacts";

export interface ContextoDaConsulta {
  organizationId: string;
  requestId: string;
  /** Fuso IANA da organização — conta o dia do filtro de data. Ausente = UTC. */
  timezone?: string | null;
  agora?: Date;
  /**
   * Só o que o lote e a exportação operam: fora o contato ANONIMIZADO (LGPD). A lista não liga
   * isto (ela mostra o anonimizado, com o selo); contagem, ids, exclusão e exportação ligam, e é
   * por isso que concordam entre si.
   */
  somenteOperaveis?: boolean;
}

/**
 * O apelido da junção com `crm_leads`. Sai da linha antes da resposta (`semJuncoes`).
 *
 * UMA junção só para funil, etapa e campo do negócio, e é de propósito: com duas junções
 * (`!inner` cada uma), "funil X" e "utm_source = google" casariam negócios DIFERENTES do
 * mesmo contato — um no funil X, outro com o utm. Os três predicados juntos têm de valer no
 * MESMO negócio.
 */
const JUNCAO = "lf";
const FK_DO_NEGOCIO = "crm_leads!crm_leads_contact_id_fkey!inner(id)";

function campoDeNegocioAtivo(f: FiltrosDeContatos): boolean {
  return Boolean(f.campo && f.campo_valor && f.campo_escopo === "negocio");
}

/** As colunas pedidas + a junção, quando algum filtro de negócio está ativo. */
export function colunasComJuncoes(colunas: string, f: FiltrosDeContatos): string {
  return f.funil || f.etapa || campoDeNegocioAtivo(f) ? `${colunas}, ${JUNCAO}:${FK_DO_NEGOCIO}` : colunas;
}

/** Tira da linha as junções de filtro: elas servem para filtrar, não fazem parte do contato. */
export function semJuncoes<T extends object>(linha: T): T {
  const copia = { ...(linha as Record<string, unknown>) };
  delete copia[JUNCAO];
  return copia as T;
}

/**
 * Escapa os curingas do LIKE para o valor ser lido literalmente.
 *
 * `*` é curinga do PostgREST (vira `%` antes de chegar ao banco) e NÃO tem escape — medido: `\*`
 * não casa nada. Vira `_` (um caractere qualquer): "a*b" acha o texto literal "a*b" e deixa de
 * significar "a, qualquer coisa, b".
 */
function escaparLike(valor: string): string {
  return valor.replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, "_");
}

/**
 * A consulta de contatos já filtrada, DENTRO de `{ query }`. O chamador acrescenta
 * ordem, limite, cursor e faixa — nunca mais filtro de conjunto.
 *
 * ⚠️ O builder do PostgREST é "thenable": devolvê-lo direto de uma função `async`
 * (ou dar `await` nele) EXECUTA a consulta antes de o chamador acrescentar ordem e
 * faixa. Por isso o retorno é um objeto — o `await` resolve o objeto, não o builder.
 *
 * `opcoes` é o segundo argumento do `select` do supabase-js (`{ count, head }`), para
 * a contagem usar exatamente os mesmos filtros.
 */
export async function consultaDeContatos(
  supabase: SupabaseClient,
  colunas: string,
  f: FiltrosDeContatos,
  ctx: ContextoDaConsulta,
  opcoes?: { count?: "exact"; head?: boolean },
) {
  let query = supabase
    .from("contacts")
    .select(colunasComJuncoes(colunas, f), opcoes)
    .eq("organization_id", ctx.organizationId)
    // A LÁPIDE DE FUSÃO NÃO É UM CONTATO VIVO — ver o histórico em
    // `app/api/v1/contacts/_handler.ts` (a lista foi a única superfície que não
    // filtrava). Lote e exportação herdam a mesma regra por passar por aqui.
    .is("is_merged_into", null);
  if (ctx.somenteOperaveis) query = query.eq("is_anonymized", false);

  const busca = f.search?.trim();
  if (busca) {
    // ⚠️ `%` e `_` são curingas do LIKE, e `,`/`(`/`)` são delimitadores do DSL
    // do `.or()` — um nome com vírgula ("Silva, Maria") injetaria uma condição
    // extra na string do filtro. Mesmo escape de conversations/_handler.ts.
    const s = busca
      .replace(/[%_]/g, (m) => `\\${m}`)
      .replace(/\*/g, "_") // `*` é curinga do PostgREST e não tem escape: ver `escaparLike`
      .replace(/[,()]/g, " ");
    const digits = busca.replace(/\D/g, "");
    const orParts = [
      `name.ilike.%${s}%`,
      // `display_name` é a coluna que a tela MOSTRA, e a ÚNICA preenchida em
      // metade da base (contato que entra pelo WhatsApp nasce só com o pushName).
      // Buscar sem ela devolve zero para quem existe.
      `display_name.ilike.%${s}%`,
      `email.ilike.%${s}%`,
      `phone_number.ilike.%${s}%`,
    ];
    if (digits.length >= 8) {
      // 10/11 dígitos sem DDI: no Brasil é DDD+local. Sem o 55, `3284793302`
      // não gera a variante com o 9 e o cadastro `+5532984793302` some da busca.
      const base =
        !digits.startsWith("55") && (digits.length === 10 || digits.length === 11)
          ? `55${digits}`
          : digits;
      for (const v of phoneLookupVariants(base)) {
        const d = v.replace(/\D/g, "");
        if (d && d !== digits) orParts.push(`phone_number.ilike.%${d}%`);
      }
    }
    if (digits.length === 11) {
      // A consulta do usuário não enxerga `cpf_hash`: o contato do CPF é achado pelo servidor e entra na busca por id.
      const hash = hashCpf(digits);
      if (hash) {
        const achados = await idsPorHashDeCpf(ctx.organizationId, hash);
        if (achados.error) {
          throw new ApiError(500, "internal_error", undefined, ctx.requestId, achados.error.message);
        }
        for (const id of achados.ids) orParts.push(`id.eq.${id}`);
      }
    }
    query = query.or(orParts.join(","));
  }

  if (f.tag) query = query.contains("tags", [f.tag]);
  if (f.source) query = query.eq("source", f.source);

  const agora = ctx.agora ?? new Date();
  const criado = intervaloEmInstantes(periodoDoFiltro(f, "criado"), agora, ctx.timezone);
  if (criado?.gte) query = query.gte("created_at", criado.gte);
  if (criado?.lt) query = query.lt("created_at", criado.lt);
  const ativ = intervaloEmInstantes(periodoDoFiltro(f, "ativ"), agora, ctx.timezone);
  if (ativ?.gte) query = query.gte("last_activity_at", ativ.gte);
  if (ativ?.lt) query = query.lt("last_activity_at", ativ.lt);

  const comJuncao = Boolean(f.funil || f.etapa || campoDeNegocioAtivo(f));
  if (comJuncao) {
    query = query.eq(`${JUNCAO}.organization_id`, ctx.organizationId);
    if (f.funil) query = query.eq(`${JUNCAO}.pipeline_id`, f.funil);
    if (f.etapa) query = query.eq(`${JUNCAO}.stage_id`, f.etapa);
  }

  if (f.campo && f.campo_valor) {
    if (!CHAVE_DE_CAMPO_FILTRAVEL.test(f.campo) || chaveSensivelDeCampo(f.campo)) {
      throw new ApiError(422, "validation_failed", undefined, ctx.requestId, "Campo inválido.");
    }
    const padrao =
      f.campo_op === "igual" ? escaparLike(f.campo_valor) : `%${escaparLike(f.campo_valor)}%`;
    query = query.ilike(
      f.campo_escopo === "negocio" ? `${JUNCAO}.custom_fields->>${f.campo}` : `custom_fields->>${f.campo}`,
      padrao,
    );
  }

  return { query };
}

/** Quantos contatos o filtro alcança (a conta do "Selecionar todos os N"). */
export async function contarContatos(
  supabase: SupabaseClient,
  f: FiltrosDeContatos,
  ctx: ContextoDaConsulta,
): Promise<number> {
  const { query } = await consultaDeContatos(supabase, "id", f, ctx, { count: "exact", head: true });
  const { count, error } = await query;
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  return count ?? 0;
}

const TAMANHO_DA_PAGINA = 1_000;

/**
 * Os ids que o filtro alcança, resolvidos NO SERVIDOR, em ordem estável (por id).
 * Para no teto + 1: o chamador só precisa saber SE passou, não quanto.
 */
export async function idsDoFiltro(
  supabase: SupabaseClient,
  f: FiltrosDeContatos,
  ctx: ContextoDaConsulta,
  teto: number,
): Promise<{ ids: string[]; excedeu: boolean }> {
  const ids: string[] = [];
  for (let de = 0; ids.length <= teto; de += TAMANHO_DA_PAGINA) {
    const { query } = await consultaDeContatos(supabase, "id", f, ctx);
    const { data, error } = await query.order("id", { ascending: true }).range(de, de + TAMANHO_DA_PAGINA - 1);
    if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
    const pagina = (data ?? []) as unknown as Array<{ id: string }>;
    for (const linha of pagina) ids.push(linha.id);
    if (pagina.length < TAMANHO_DA_PAGINA) break;
  }
  return { ids: ids.slice(0, teto), excedeu: ids.length > teto };
}
