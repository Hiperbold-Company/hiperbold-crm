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
 *    PostgREST (`eq`, `ilike`, `imatch`, `contains`, `gte`, `lt`), que parametrizam o valor.
 *    A busca vira regex por `padraoRegexDeBusca` (ignora acento; `lib/contacts/busca-regex.ts`).
 *  - A chave de campo personalizado vira caminho JSON (`custom_fields->>chave`) e
 *    por isso é revalidada AQUI por `CHAVE_DE_CAMPO_FILTRAVEL`, mesmo já tendo
 *    passado pelo Zod: esta função é chamada também com objeto montado em código.
 *  - `%` e `_` do valor digitado são escapados: "50%" procura "50%", não "50" e
 *    qualquer coisa.
 *  - Funil/etapa/campo-de-negócio entram por JUNÇÃO (`!inner`) na tabela de
 *    negócios, com `organization_id` conferido na própria junção. Sem lista de ids
 *    no meio — uma base de 6.000 contatos estouraria a URL.
 *  - O campo no escopo "qualquer" (o padrão da tela) é um OU entre o campo do próprio
 *    contato e uma segunda junção, SEM `!inner`, com os negócios que têm o valor
 *    (`lc.not.is.null`). O valor entra no `or` entre aspas, com `\` e `"` escapados:
 *    é o único texto do usuário que passa pelo DSL do `or`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { hashCpf } from "@/lib/contacts/cpf";
import { idsPorHashDeCpf } from "@/lib/contacts/cpf-do-contato";
import { intervaloEmInstantes, periodoDoFiltro } from "@/lib/contacts/filtros";
import { padraoRegexDeBusca } from "@/lib/contacts/busca-regex";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { arrayDeUmValorParaOr } from "@/lib/inbox/marcador-da-conversa";
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
  /**
   * Só este contato — o escopo do turno do agente (`crm_search_contacts`). Também tira da busca o
   * nome da agenda do celular, que é rótulo interno da equipe.
   */
  soContato?: string;
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
/**
 * A junção do campo no escopo "qualquer": SEM `!inner`, para o contato que tem o valor no
 * PRÓPRIO cadastro continuar na lista mesmo sem negócio com o valor. Ela só filtra pelo `or`
 * (`lc.not.is.null`). Leva os mesmos predicados de funil/etapa de `lf`: com funil escolhido, o
 * valor tem de estar num negócio DESSE funil — e o contato tem de ter negócio nele (`lf`).
 */
const JUNCAO_DO_CAMPO = "lc";
const FK_DO_NEGOCIO_OPCIONAL = "crm_leads!crm_leads_contact_id_fkey(id)";
/** Teto de etapas num filtro: o `in` vai na URL, e a tela nunca passa de um funil. */
export const MAXIMO_DE_ETAPAS_NO_FILTRO = 100;

function campoAtivo(f: FiltrosDeContatos): boolean {
  return Boolean(f.campo && f.campo_valor);
}

function campoDeNegocioAtivo(f: FiltrosDeContatos): boolean {
  return campoAtivo(f) && f.campo_escopo === "negocio";
}

function campoEmQualquerAtivo(f: FiltrosDeContatos): boolean {
  return campoAtivo(f) && f.campo_escopo === "qualquer";
}

function temEtapa(f: FiltrosDeContatos): boolean {
  return Boolean(f.etapa && f.etapa.length > 0);
}

/**
 * O filtro lê `crm_leads`? Decide a regra D-148 do token (route.ts): funil, etapa e campo que
 * olha negócio ("negocio" e "qualquer").
 */
export function filtraPorNegocio(f: FiltrosDeContatos): boolean {
  return Boolean(f.funil || temEtapa(f) || campoDeNegocioAtivo(f) || campoEmQualquerAtivo(f));
}

/** As colunas pedidas + as junções, quando algum filtro de negócio está ativo. */
export function colunasComJuncoes(colunas: string, f: FiltrosDeContatos): string {
  let saida = colunas;
  if (f.funil || temEtapa(f) || campoDeNegocioAtivo(f)) saida += `, ${JUNCAO}:${FK_DO_NEGOCIO}`;
  if (campoEmQualquerAtivo(f)) saida += `, ${JUNCAO_DO_CAMPO}:${FK_DO_NEGOCIO_OPCIONAL}`;
  return saida;
}

/** Tira da linha as junções de filtro: elas servem para filtrar, não fazem parte do contato. */
export function semJuncoes<T extends object>(linha: T): T {
  const copia = { ...(linha as Record<string, unknown>) };
  delete copia[JUNCAO];
  delete copia[JUNCAO_DO_CAMPO];
  return copia as T;
}

/**
 * Valor para o DSL do `or` do PostgREST: entre aspas, com `\` e `"` escapados. Sem as aspas,
 * `,` `(` `)` do valor abririam outra condição.
 */
function valorEntreAspas(valor: string): string {
  return `"${valor.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
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
    // O placeholder de GRUPO (`kind='whatsapp_group'`) não é uma pessoa da base: a lista, a
    // contagem, o lote e a exportação concordam em operar só pessoa.
    .eq("kind", "person")
    // A LÁPIDE DE FUSÃO NÃO É UM CONTATO VIVO — ver o histórico em
    // `app/api/v1/contacts/_handler.ts` (a lista foi a única superfície que não
    // filtrava). Lote e exportação herdam a mesma regra por passar por aqui.
    .is("is_merged_into", null);
  if (ctx.somenteOperaveis) query = query.eq("is_anonymized", false);

  // Só este contato — o escopo do turno do agente (`crm_search_contacts`). Vai no WHERE, antes do limite.
  if (ctx.soContato) query = query.eq("id", ctx.soContato);

  // ─── A busca do upstream (#1835, F2): regex, não LIKE ───────────────────────
  // O termo passa pela régua única de `lib/inbox/termo-de-busca.ts` e vira regex
  // (`padraoRegexDeBusca`): "Joao" acha "João" e vice-versa (o banco não tem
  // `unaccent`), espaço/vírgula viram curinga, `%`/`_` digitados ficam literais.
  // Os PARÊNTESES saem antes: são delimitador do DSL do `.or()` do PostgREST.
  const termoDeTexto = f.search ? f.search.replace(/[()]/g, " ") : undefined;
  if (f.search && termoDeTexto !== undefined && termoDeTexto.trim()) {
    const s = padraoRegexDeBusca(termoDeTexto);
    const digits = f.search.replace(/\D/g, "");
    const orParts = [
      `name.imatch.${s}`,
      // `display_name` é a coluna que a tela MOSTRA, e a ÚNICA preenchida em
      // metade da base (contato que entra pelo WhatsApp nasce só com o pushName).
      `display_name.imatch.${s}`,
      // O nome da agenda do celular (#2439) é SÓ DA EQUIPE: na busca do agente
      // (`soContato`) casar nele vazaria o rótulo interno ao cliente aos pedaços.
      ...(ctx.soContato ? [] : [`address_book_name.imatch.${s}`]),
      `email.imatch.${s}`,
      `phone_number.imatch.${s}`,
    ];
    if (digits.length >= 8) {
      // 10/11 dígitos sem DDI: no Brasil é DDD+local. Sem o 55, `3284793302`
      // não gera a variante com o 9 e o cadastro `+5532984793302` some da busca.
      const base =
        !digits.startsWith("55") && (digits.length === 10 || digits.length === 11)
          ? `55${digits}`
          : digits;
      const criteriosDeTelefone = [`phone_number.imatch.${s}`];
      for (const v of phoneLookupVariants(base)) {
        const d = v.replace(/\D/g, "");
        if (d && d !== digits) {
          orParts.push(`phone_number.ilike.%${d}%`);
          criteriosDeTelefone.push(`phone_number.ilike.%${d}%`);
        }
      }
      // Ficha cujo TELEFONE EXTRA (`contact_phones`) casa o termo também entra. Só
      // quando o termo tem cara de telefone: texto com letras e dígitos não é busca
      // de número, e uma consulta a mais por termo hostil é o que a cerca conta.
      if (/^[\d\s()+.-]+$/.test(f.search.trim())) {
        const { data: extras } = await supabase
          .from("contact_phones")
          .select("contact_id")
          .eq("organization_id", ctx.organizationId)
          .or(criteriosDeTelefone.join(","));
        const idsDeExtras = [
          ...new Set(((extras ?? []) as { contact_id: string }[]).map((r) => r.contact_id)),
        ];
        if (idsDeExtras.length > 0) orParts.push(`id.in.(${idsDeExtras.join(",")})`);
      }
    }
    if (digits.length === 11) {
      // A consulta do usuário não enxerga `cpf_hash` (D-216): o contato do CPF é achado pelo
      // servidor e entra na busca por id.
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

  // E/OU entre etiquetas (#1274, upstream): E = `contains` com a lista; OU = um
  // `or=` com um `ov` por etiqueta (`overlaps` repetido viraria E no PostgREST).
  if (f.tag && f.tag.length > 1 && f.modo === "ou") {
    query = query.or(f.tag.map((marcador) => `tags.ov.${arrayDeUmValorParaOr(marcador)}`).join(","));
  } else if (f.tag) {
    query = query.contains("tags", f.tag);
  }
  // Só o opt-out do titular (`yes`/`no`); ausente = todos.
  if (f.blocked) query = query.eq("is_blocked", f.blocked === "yes");
  // Pessoal fora por padrão; `pessoais=true` lista SÓ pessoais (spec 21, etapa 13).
  query = query.eq("is_personal", f.pessoais === true);
  if (f.source) query = query.eq("source", f.source);

  const agora = ctx.agora ?? new Date();
  const criado = intervaloEmInstantes(periodoDoFiltro(f, "criado"), agora, ctx.timezone);
  if (criado?.gte) query = query.gte("created_at", criado.gte);
  if (criado?.lt) query = query.lt("created_at", criado.lt);
  const ativ = intervaloEmInstantes(periodoDoFiltro(f, "ativ"), agora, ctx.timezone);
  if (ativ?.gte) query = query.gte("last_activity_at", ativ.gte);
  if (ativ?.lt) query = query.lt("last_activity_at", ativ.lt);

  if (f.etapa && f.etapa.length > MAXIMO_DE_ETAPAS_NO_FILTRO) {
    throw new ApiError(422, "validation_failed", undefined, ctx.requestId, "Etapas demais no filtro.");
  }
  const comJuncao = Boolean(f.funil || temEtapa(f) || campoDeNegocioAtivo(f));
  if (comJuncao) {
    query = query.eq(`${JUNCAO}.organization_id`, ctx.organizationId);
    if (f.funil) query = query.eq(`${JUNCAO}.pipeline_id`, f.funil);
    if (temEtapa(f)) query = query.in(`${JUNCAO}.stage_id`, f.etapa!);
  }

  if (f.campo && f.campo_valor) {
    if (!CHAVE_DE_CAMPO_FILTRAVEL.test(f.campo) || chaveSensivelDeCampo(f.campo)) {
      throw new ApiError(422, "validation_failed", undefined, ctx.requestId, "Campo inválido.");
    }
    const padrao =
      f.campo_op === "igual" ? escaparLike(f.campo_valor) : `%${escaparLike(f.campo_valor)}%`;
    if (f.campo_escopo === "qualquer") {
      // O valor no próprio contato OU num negócio dele (do funil/etapas escolhidos, se houver).
      const lc = JUNCAO_DO_CAMPO;
      query = query.eq(`${lc}.organization_id`, ctx.organizationId);
      if (f.funil) query = query.eq(`${lc}.pipeline_id`, f.funil);
      if (temEtapa(f)) query = query.in(`${lc}.stage_id`, f.etapa!);
      query = query.ilike(`${lc}.custom_fields->>${f.campo}`, padrao);
      query = query.or(`custom_fields->>${f.campo}.ilike.${valorEntreAspas(padrao)},${lc}.not.is.null`);
    } else {
      query = query.ilike(
        f.campo_escopo === "negocio" ? `${JUNCAO}.custom_fields->>${f.campo}` : `custom_fields->>${f.campo}`,
        padrao,
      );
    }
  }

  return { query };
}

/**
 * A busca abaixo do piso (#1835: menos de dois caracteres úteis) não vai ao banco — a lista responde
 * vazio. Contagem, lote e exportação seguem a mesma régua, senão "selecionar todos os N" com `a`
 * digitado alcançaria a base inteira que a lista não mostrou.
 */
export function buscaAbaixoDoPiso(f: Pick<FiltrosDeContatos, "search">): boolean {
  if (f.search === undefined) return false;
  return !buscaValeConsulta(f.search.replace(/[()]/g, " "));
}

/** Quantos contatos o filtro alcança (a conta do "Selecionar todos os N"). */
export async function contarContatos(
  supabase: SupabaseClient,
  f: FiltrosDeContatos,
  ctx: ContextoDaConsulta,
): Promise<number> {
  if (buscaAbaixoDoPiso(f)) return 0;
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
  if (buscaAbaixoDoPiso(f)) return { ids: [], excedeu: false };
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
