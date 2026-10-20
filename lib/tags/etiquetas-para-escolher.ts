/**
 * AS ETIQUETAS PARA ESCOLHER — o que o editor de tags do contato (Inbox) oferece.
 *
 * ─── De onde vem a lista ────────────────────────────────────────────────────
 *
 * A MESMA fonte da tela Configurações › Tags: o vocabulário da organização
 * (`organizations.settings.tags` = `{tag, cor, descricao}`) mais o que está em uso
 * (`fn_vocabulario_de_tags`, que já une vocabulário, sementes e uso em contatos,
 * leads, conversas e regras). Antes o editor lia só "tags em uso nos contatos", e
 * uma organização recém-configurada — com o vocabulário cadastrado e nenhum
 * contato etiquetado — não via sugestão nenhuma.
 *
 * ─── Ordem e grupo ──────────────────────────────────────────────────────────
 *
 * A função de banco devolve em ordem ALFABÉTICA (`order by chave`) e perde a ordem
 * em que a organização cadastrou — que é a que ela pensou, agrupando origem,
 * situação, profissional. Por isso a ordem vem do `settings.tags`; a função só
 * acrescenta o que o vocabulário não tem. O GRUPO é a `descricao` da entrada.
 *
 * Funções PURAS: recebem o `settings` e as linhas já lidos. Nada de rede.
 */
import { chaveDaEtiqueta, normalizarCorDeEtiqueta } from "@/lib/tags/cor-da-etiqueta";

export type OpcaoDeEtiqueta = {
  /** A grafia como a organização cadastrou ("Novo Paciente"). */
  tag: string;
  cor: string | null;
  /** A `descricao` do vocabulário; `null` = sem grupo ("Outras" na tela). */
  grupo: string | null;
};

/** Uma linha de `fn_vocabulario_de_tags` — só o que interessa aqui. */
export type LinhaParaEscolher = {
  tag: string;
  cor: string | null;
  descricao: string | null;
};

function texto(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo === "" ? null : limpo;
}

/**
 * O servidor monta a lista: entradas do `settings.tags` NA ORDEM cadastrada (string
 * ou objeto, as duas formas que a 0264 admite), depois o que só a função de banco
 * conhece (uso, sementes), sem repetir pela chave canônica.
 */
export function opcoesDeEtiqueta(
  settings: unknown,
  linhas: readonly LinhaParaEscolher[],
): OpcaoDeEtiqueta[] {
  const saida: OpcaoDeEtiqueta[] = [];
  const vistas = new Set<string>();

  function entrar(tag: string | null, cor: unknown, grupo: unknown): void {
    if (tag === null) return;
    const chave = chaveDaEtiqueta(tag);
    if (vistas.has(chave)) return;
    vistas.add(chave);
    saida.push({ tag, cor: normalizarCorDeEtiqueta(cor), grupo: texto(grupo) });
  }

  const cadastradas = (settings as Record<string, unknown> | null | undefined)?.["tags"];
  if (Array.isArray(cadastradas)) {
    for (const entrada of cadastradas) {
      if (typeof entrada === "string") {
        entrar(texto(entrada), null, null);
      } else if (typeof entrada === "object" && entrada !== null) {
        const o = entrada as Record<string, unknown>;
        entrar(texto(o["tag"]), o["cor"], o["descricao"]);
      }
    }
  }
  for (const linha of linhas) entrar(texto(linha.tag), linha.cor, linha.descricao);
  return saida;
}

/** Sem acento e sem caixa — a régua da busca. */
export function paraBusca(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

export type GrupoDeEtiquetas = { grupo: string | null; opcoes: OpcaoDeEtiqueta[] };

/**
 * Agrupa pelo grupo, na ordem em que cada grupo aparece pela primeira vez; o que
 * não tem grupo vai para o fim (`grupo: null` = "Outras"). Filtra por `busca`
 * (sem acento/caixa) no NOME da etiqueta. Grupo sem etiqueta restante some.
 */
export function agruparOpcoes(
  opcoes: readonly OpcaoDeEtiqueta[],
  busca: string,
): GrupoDeEtiquetas[] {
  const termo = paraBusca(busca);
  const porGrupo = new Map<string, OpcaoDeEtiqueta[]>();
  const semGrupo: OpcaoDeEtiqueta[] = [];
  for (const opcao of opcoes) {
    if (termo !== "" && !paraBusca(opcao.tag).includes(termo)) continue;
    if (opcao.grupo === null) {
      semGrupo.push(opcao);
      continue;
    }
    // "Origem do lead" e "origem do lead" são o mesmo grupo para quem lê.
    const chave = opcao.grupo.toLowerCase();
    const lista = porGrupo.get(chave);
    if (lista) lista.push(opcao);
    else porGrupo.set(chave, [opcao]);
  }
  const grupos: GrupoDeEtiquetas[] = [...porGrupo.values()].map((lista) => ({
    grupo: lista[0]!.grupo,
    opcoes: lista,
  }));
  if (semGrupo.length > 0) grupos.push({ grupo: null, opcoes: semGrupo });
  return grupos;
}
