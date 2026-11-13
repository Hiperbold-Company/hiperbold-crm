/**
 * EXPORTAR E IMPORTAR UMA AUTOMAÇÃO como arquivo `.json` — a mesma automação em
 * outra conta, ou uma automação escrita fora do CRM (por uma pessoa ou por uma IA)
 * a partir de um passo a passo.
 *
 * ═══ O formato ══════════════════════════════════════════════════════════════
 *
 *   {
 *     "formato": "hiperbold-automacao", "versao": 1,
 *     "automacao": { "nome": "...", "grafo": { "nodes": [...], "edges": [...] } },
 *     "referencias": [ { "id": "r1", "tipo": "etapa", "nome": "Qualificado · Vendas" } ]
 *   }
 *
 * O grafo é o MESMO que o editor grava (`flowGraphSchema`), com uma diferença:
 * nenhum id de linha da organização (etapa, funil, pessoa, canal, fonte de
 * captação, chave secreta, outra automação, modelo de mensagem) aparece nele.
 * Onde o grafo teria o id, o arquivo tem `"ref:<id da referência>"`, e a lista
 * `referencias` diz o TIPO e o NOME legível de cada uma. `"ref:esta"` é a própria
 * automação (o "Iniciar automação" que reinicia a si mesma).
 *
 * ═══ Por que a troca é GENÉRICA (todo uuid do grafo) e não campo a campo ═══
 *
 * Os ids moram em muitos lugares (ações de CRM, gatilhos, condições, valor de
 * uma condição de campo `lead.stage_id`, cabeçalho HTTP), e cada caixa nova
 * cria outro. Uma lista de caminhos esquecida aqui vazaria o id de uma conta
 * para outra em silêncio. Por isso a exportação troca TODO texto que é um uuid
 * inteiro, achando o tipo pelo catálogo da organização (e, se a linha já foi
 * apagada, pelo nome do campo). O que não dá para classificar RECUSA a
 * exportação — nunca sai id cru.
 *
 * A importação é o espelho: arquivo com uuid cru é recusado inteiro, e cada
 * `ref:` só vira id depois que a pessoa (ou o casamento por nome) escolhe uma
 * linha DA ORGANIZAÇÃO DE DESTINO, do tipo certo. Nenhum id do arquivo chega ao
 * banco.
 *
 * ═══ O que o arquivo NÃO leva ═══════════════════════════════════════════════
 *
 * Valor de chave secreta (só o NOME da chave), texto escrito num cabeçalho de
 * credencial (sai em branco), e-mail de pessoa, versões publicadas, execuções e
 * o estado ligado. A automação importada nasce RASCUNHO (desligada) e só vai ao
 * ar pelo mesmo "Publicar" de qualquer automação desenhada à mão.
 *
 * Este arquivo é PURO: quem lê o banco é `portabilidade-db.ts`.
 */
import { z } from "zod";

import { cabecalhoComSegredoEscrito, type CabecalhoHttp } from "@/lib/automacoes/http";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { MAX_FOLLOWUP_FLOW_NAME } from "@/lib/followup/nome-da-copia";

/** Identifica o arquivo. Mudar quebra todo arquivo já exportado — não mude. */
export const FORMATO_DA_AUTOMACAO = "hiperbold-automacao" as const;
/** Sobe quando o envelope muda de forma incompatível. */
export const VERSAO_DA_AUTOMACAO = 1 as const;
/** Teto do arquivo. Um grafo no limite fica muito abaixo disto. */
export const TAMANHO_MAXIMO_DA_AUTOMACAO = 512 * 1024;

export const TIPOS_DE_REFERENCIA = [
  "funil",
  "etapa",
  "pessoa",
  "fonte",
  "canal",
  "segredo",
  "automacao",
  "modelo",
] as const;
export type TipoDeReferencia = (typeof TIPOS_DE_REFERENCIA)[number];

/** A própria automação (o arquivo não sabe o id que ela vai ganhar). */
export const REF_DESTA_AUTOMACAO = "ref:esta";
const PREFIXO = "ref:";
const ID_DE_REFERENCIA = /^[a-z0-9_-]{1,40}$/i;
export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const referenciaSchema = z.strictObject({
  id: z
    .string()
    .regex(ID_DE_REFERENCIA, "Use letras, números, _ ou -")
    .refine((id) => id.toLowerCase() !== "esta", { message: "«esta» é reservado para a própria automação" }),
  tipo: z.enum(TIPOS_DE_REFERENCIA),
  /** Nome na conta de origem. `null` = a linha já tinha sido apagada lá. */
  nome: z.string().trim().min(1).max(200).nullable(),
});
export type ReferenciaDoArquivo = z.infer<typeof referenciaSchema>;

export const arquivoDeAutomacaoSchema = z.strictObject({
  formato: z.literal(FORMATO_DA_AUTOMACAO),
  versao: z.literal(VERSAO_DA_AUTOMACAO),
  exportado_em: z.string().max(40).optional(),
  automacao: z.strictObject({
    nome: z.string().trim().min(1).max(MAX_FOLLOWUP_FLOW_NAME),
    /** Conferido DEPOIS da troca das referências (`flowGraphSchema` exige uuid onde o arquivo tem `ref:`). */
    grafo: z.strictObject({ nodes: z.array(z.unknown()).max(200), edges: z.array(z.unknown()).max(400) }).passthrough(),
  }),
  referencias: z
    .array(referenciaSchema)
    .max(200)
    .default([])
    .refine((rs) => new Set(rs.map((r) => r.id.toLowerCase())).size === rs.length, {
      message: "id de referência repetido",
    }),
});
export type ArquivoDeAutomacao = z.infer<typeof arquivoDeAutomacaoSchema>;

/** Uma linha da organização que o grafo pode citar. */
export interface ItemDoCatalogo {
  id: string;
  tipo: TipoDeReferencia;
  /** Rótulo legível: «Etapa · Funil» para etapa, o nome nos demais. */
  nome: string;
  /** Pode ser escolhida como destino (etapa e funil arquivados, pessoa revogada e fonte desligada não). */
  ativo: boolean;
}
export type CatalogoDaConta = readonly ItemDoCatalogo[];

/**
 * Tipo pelo NOME do campo, para o id que o catálogo não conhece (linha apagada).
 * Só nomes que no grafo significam UMA coisa; `value`, `to`, `assignee` ficam de
 * fora de propósito — o catálogo decide esses, e sem catálogo a exportação recusa.
 */
const TIPO_PELO_CAMPO: Record<string, TipoDeReferencia> = {
  pipeline_id: "funil",
  pipeline_ids: "funil",
  stage_id: "etapa",
  stage_ids: "etapa",
  user_id: "pessoa",
  user_ids: "pessoa",
  usuario_id: "pessoa",
  capture_source_ids: "fonte",
  channel_session_ids: "canal",
  secret_id: "segredo",
  pointer_id: "automacao",
  from_pointer_ids: "automacao",
  template_id: "modelo",
  fallback_template_id: "modelo",
};

/** Percorre o valor trocando cada TEXTO por `troca(texto, campo, caminho)`. Não muta. */
/** Um grafo real não passa de ~12 níveis; o teto barra arquivo feito para estourar a pilha. */
export const PROFUNDIDADE_MAXIMA = 40;
export class ArquivoFundoDemais extends Error {}

function trocarTextos(
  valor: unknown,
  troca: (texto: string, campo: string | undefined, caminho: string) => string,
  campo?: string,
  caminho = "",
  nivel = 0,
): unknown {
  if (nivel > PROFUNDIDADE_MAXIMA) throw new ArquivoFundoDemais(caminho);
  if (typeof valor === "string") return troca(valor, campo, caminho);
  if (Array.isArray(valor)) return valor.map((v, i) => trocarTextos(v, troca, campo, `${caminho}.${i}`, nivel + 1));
  if (valor && typeof valor === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) {
      saida[k] = trocarTextos(v, troca, k, caminho ? `${caminho}.${k}` : k, nivel + 1);
    }
    return saida;
  }
  return valor;
}

// ─── Exportação ─────────────────────────────────────────────────────────────

export class ErroDeExportacao extends Error {
  constructor(
    readonly codigo: "id_sem_tipo",
    readonly caminho: string,
  ) {
    super(`${codigo}: ${caminho}`);
  }
}

/** Cabeçalho HTTP de credencial com o valor ESCRITO sai em branco (o publish já o recusaria). */
function semSegredoEscrito(grafo: FlowGraph): FlowGraph {
  return {
    ...grafo,
    nodes: grafo.nodes.map((n) => {
      if (n.type !== "http_request") return n;
      const headers = (n.config.headers as CabecalhoHttp[]).map((h) =>
        cabecalhoComSegredoEscrito(h) ? { ...h, value: "" } : h,
      );
      return { ...n, config: { ...n.config, headers } } as typeof n;
    }),
  };
}

/**
 * Monta o arquivo. `catalogo` é o da organização de ORIGEM (inclusive linhas
 * inativas, para dar nome a tudo). Lança `ErroDeExportacao` quando sobra um id
 * que não dá para classificar — exportar assim levaria o id cru para outra conta.
 */
export function exportarAutomacao(
  entrada: { id: string; nome: string; grafo: FlowGraph },
  catalogo: CatalogoDaConta,
  agora: Date,
): ArquivoDeAutomacao {
  const porId = new Map(catalogo.map((i) => [i.id.toLowerCase(), i]));
  const referencias: ReferenciaDoArquivo[] = [];
  const refDoId = new Map<string, string>();
  const contadores = new Map<TipoDeReferencia, number>();

  const grafo = trocarTextos(semSegredoEscrito(entrada.grafo), (texto, campo, caminho) => {
    if (!UUID_RX.test(texto)) return texto;
    const id = texto.toLowerCase();
    if (id === entrada.id.toLowerCase()) return REF_DESTA_AUTOMACAO;
    const ja = refDoId.get(id);
    if (ja) return PREFIXO + ja;
    const item = porId.get(id);
    const tipo = item?.tipo ?? (campo ? TIPO_PELO_CAMPO[campo] : undefined);
    if (!tipo) throw new ErroDeExportacao("id_sem_tipo", caminho);
    const n = (contadores.get(tipo) ?? 0) + 1;
    contadores.set(tipo, n);
    const ref = `${tipo}_${n}`;
    refDoId.set(id, ref);
    referencias.push({ id: ref, tipo, nome: item ? item.nome.slice(0, 200) : null });
    return PREFIXO + ref;
  }) as ArquivoDeAutomacao["automacao"]["grafo"];

  return {
    formato: FORMATO_DA_AUTOMACAO,
    versao: VERSAO_DA_AUTOMACAO,
    exportado_em: agora.toISOString(),
    automacao: { nome: entrada.nome.trim().slice(0, MAX_FOLLOWUP_FLOW_NAME) || "Automação", grafo },
    referencias,
  };
}

/** Nome do arquivo baixado, sem o que um sistema de arquivos recusa. */
export function nomeDoArquivoDaAutomacao(nome: string): string {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return `${base || "automacao"}.automacao.json`;
}

// ─── Leitura do arquivo (importação, passo 1) ───────────────────────────────

/** Uuid falso e estável, só para conferir a ESTRUTURA do grafo antes das escolhas. */
function uuidDeConferencia(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export type LeituraDoArquivo =
  | { ok: true; arquivo: ArquivoDeAutomacao; usadas: ReferenciaDoArquivo[] }
  | { ok: false; problemas: string[] };

function problemasDoZod(erro: z.ZodError, prefixo = "", limite = 20): string[] {
  return erro.issues.slice(0, limite).map((issue) => {
    const caminho = [prefixo, ...issue.path.map(String)].filter(Boolean).join(".");
    return caminho ? `${caminho}: ${issue.message}` : issue.message;
  });
}

/**
 * Confere o arquivo INTEIRO antes de qualquer escrita: envelope, referências
 * declaradas, nenhum uuid cru, e o grafo válido com as referências no lugar.
 * Arquivo com qualquer problema é recusado — nada é criado pela metade.
 */
export function lerArquivoDeAutomacao(bruto: unknown, opcoesDoZod?: { error: z.core.$ZodErrorMap }): LeituraDoArquivo {
  const env = arquivoDeAutomacaoSchema.safeParse(bruto, opcoesDoZod);
  if (!env.success) return { ok: false, problemas: problemasDoZod(env.error) };
  const arquivo = env.data;
  const declaradas = new Map(arquivo.referencias.map((r) => [r.id.toLowerCase(), r]));

  const problemas: string[] = [];
  const usadas = new Map<string, ReferenciaDoArquivo>();
  const falsos = new Map<string, string>();
  let conferivel: unknown;
  try {
    conferivel = trocarTextos(arquivo.automacao.grafo, (texto, _campo, caminho) => {
    if (UUID_RX.test(texto)) {
      problemas.push(`automacao.grafo.${caminho}: id de conta no arquivo — use uma referência ("ref:...")`);
      return texto;
    }
    if (!texto.startsWith(PREFIXO)) return texto;
    if (texto === REF_DESTA_AUTOMACAO) return uuidDeConferencia(0);
    const id = texto.slice(PREFIXO.length).toLowerCase();
    const ref = declaradas.get(id);
    if (!ref) {
      problemas.push(`automacao.grafo.${caminho}: a referência "${texto}" não está na lista "referencias"`);
      return texto;
    }
    usadas.set(id, ref);
    if (!falsos.has(id)) falsos.set(id, uuidDeConferencia(falsos.size + 1));
    return falsos.get(id)!;
    });
  } catch (err) {
    if (err instanceof ArquivoFundoDemais) {
      return { ok: false, problemas: [`automacao.grafo: aninhamento acima de ${PROFUNDIDADE_MAXIMA} níveis`] };
    }
    throw err;
  }
  if (problemas.length > 0) return { ok: false, problemas: problemas.slice(0, 20) };

  const grafo = flowGraphSchema.safeParse(conferivel, opcoesDoZod);
  if (!grafo.success) return { ok: false, problemas: problemasDoZod(grafo.error, "automacao.grafo") };
  const inicio = grafo.data.nodes.find((n) => n.type === "trigger");
  if (!inicio || !("triggers" in inicio.config)) {
    return {
      ok: false,
      problemas: ["automacao.grafo: falta a caixa Início com os gatilhos de automação (isto é um fluxo de follow-up?)"],
    };
  }
  return { ok: true, arquivo, usadas: [...usadas.values()] };
}

// ─── Prévia e escolhas (importação, passo 2) ────────────────────────────────

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/**
 * A linha daqui que corresponde ao nome de fora — só quando é UMA. Nome que casa
 * com duas fica sem sugestão (a pessoa escolhe). Etapa: «Etapa · Funil» exato,
 * ou só a etapa quando ela é única na conta.
 */
export function sugestaoPorNome(ref: ReferenciaDoArquivo, opcoes: readonly ItemDoCatalogo[]): string | null {
  // Chave secreta NUNCA é sugerida: um arquivo de fora com «Token do ERP» e uma URL dele
  // levaria a chave homônima daqui para o host de quem escreveu o arquivo. A pessoa escolhe,
  // vendo o destino (`destinosHttp` da prévia).
  if (!ref.nome || ref.tipo === "segredo") return null;
  const alvo = normalizar(ref.nome);
  const exatos = opcoes.filter((o) => normalizar(o.nome) === alvo);
  if (exatos.length === 1) return exatos[0]!.id;
  if (exatos.length > 1 || ref.tipo !== "etapa") return null;
  const soEtapa = normalizar(ref.nome.split(" · ")[0] ?? "");
  if (!soEtapa) return null;
  const pelaEtapa = opcoes.filter((o) => normalizar(o.nome.split(" · ")[0] ?? "") === soEtapa);
  return pelaEtapa.length === 1 ? pelaEtapa[0]!.id : null;
}

export interface ReferenciaNaPrevia {
  id: string;
  tipo: TipoDeReferencia;
  nome: string | null;
  sugestao: string | null;
  opcoes: { id: string; nome: string }[];
}

export interface PreviaDaImportacao {
  nome: string;
  caixas: number;
  /** Quantas caixas de cada tipo (o que vai ser criado). */
  porTipo: Record<string, number>;
  gatilhos: string[];
  referencias: ReferenciaNaPrevia[];
  /** Cada "Requisição HTTP": para onde vai e quais chaves secretas leva. A pessoa confere antes de importar. */
  destinosHttp: { caixa: string; metodo: string; url: string; chaves: string[] }[];
}

/** O que a tela mostra antes de criar: resumo e, para cada referência, as opções DESTA conta. */
export function previaDaImportacao(
  arquivo: ArquivoDeAutomacao,
  usadas: readonly ReferenciaDoArquivo[],
  conta: CatalogoDaConta,
): PreviaDaImportacao {
  const nodes = arquivo.automacao.grafo.nodes as Array<{ type?: unknown; config?: { triggers?: Array<{ kind?: unknown }> } }>;
  const porTipo: Record<string, number> = {};
  for (const n of nodes) {
    const tipo = typeof n.type === "string" ? n.type : "?";
    porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
  }
  const gatilhos = nodes
    .filter((n) => n.type === "trigger")
    .flatMap((n) => n.config?.triggers ?? [])
    .map((g) => String(g.kind ?? ""));
  const destinosHttp = (arquivo.automacao.grafo.nodes as Array<Record<string, unknown>>)
    .filter((n) => n.type === "http_request")
    .map((n) => {
      const config = (n.config ?? {}) as { method?: unknown; url?: unknown };
      const chaves = new Set<string>();
      trocarTextos(n.config, (texto) => {
        if (texto.startsWith(PREFIXO) && texto !== REF_DESTA_AUTOMACAO) chaves.add(texto.slice(PREFIXO.length));
        return texto;
      });
      const segredos = usadas.filter((r) => r.tipo === "segredo" && chaves.has(r.id)).map((r) => r.id);
      return { caixa: String(n.label ?? n.id), metodo: String(config.method ?? ""), url: String(config.url ?? ""), chaves: segredos };
    });
  return {
    destinosHttp,
    nome: arquivo.automacao.nome,
    caixas: nodes.length,
    porTipo,
    gatilhos,
    referencias: usadas.map((ref) => {
      const opcoes = conta.filter((i) => i.ativo && i.tipo === ref.tipo);
      return {
        id: ref.id,
        tipo: ref.tipo,
        nome: ref.nome,
        sugestao: sugestaoPorNome(ref, opcoes),
        opcoes: opcoes.map((o) => ({ id: o.id, nome: o.nome })),
      };
    }),
  };
}

export type MontagemDoGrafo =
  | { ok: true; grafo: FlowGraph }
  | { ok: false; faltam: string[]; problemas: string[] };

/**
 * Troca cada `ref:` pelo id ESCOLHIDO — que tem de ser uma linha ativa desta
 * conta e do tipo da referência. Escolha ausente, de outro tipo ou de outra
 * conta deixa a referência em `faltam`, e nada é montado.
 */
export function montarGrafoImportado(
  arquivo: ArquivoDeAutomacao,
  usadas: readonly ReferenciaDoArquivo[],
  escolhas: Readonly<Record<string, string>>,
  conta: CatalogoDaConta,
  novoId: string,
): MontagemDoGrafo {
  const validos = new Map(conta.filter((i) => i.ativo).map((i) => [i.id.toLowerCase(), i.tipo]));
  const escolhaDe = new Map(Object.entries(escolhas).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  const destino = new Map<string, string>();
  const faltam: string[] = [];
  for (const ref of usadas) {
    const k = ref.id.toLowerCase();
    const id = escolhaDe.get(k);
    if (!id || validos.get(id) !== ref.tipo) faltam.push(ref.id);
    else destino.set(k, id);
  }
  if (faltam.length > 0) return { ok: false, faltam, problemas: [] };

  const trocado = trocarTextos(arquivo.automacao.grafo, (texto) => {
    if (texto === REF_DESTA_AUTOMACAO) return novoId;
    if (!texto.startsWith(PREFIXO)) return texto;
    return destino.get(texto.slice(PREFIXO.length).toLowerCase()) ?? texto;
  });
  const grafo = flowGraphSchema.safeParse(trocado);
  if (!grafo.success) return { ok: false, faltam: [], problemas: problemasDoZod(grafo.error, "automacao.grafo") };
  return { ok: true, grafo: grafo.data };
}
