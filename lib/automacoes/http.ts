/**
 * Bloco "Requisição HTTP" das automações (lote 4) — a parte PURA: o contrato
 * do bloco, a lista de cabeçalhos proibidos, a leitura de um caminho no JSON da
 * resposta e a máscara das chaves secretas.
 *
 * Quem chama a rede é `efeitos/http.ts`; quem guarda as chaves é `segredos.ts`.
 * Este arquivo não importa o grafo (`graph-schema.ts` o importa), nem banco,
 * nem rede: a tela do editor usa as mesmas regras que o publish e o motor.
 *
 * Decisões que valem para os três lados:
 *  - a chave secreta NUNCA é digitada no grafo: o cabeçalho guarda só o id da
 *    chave do cofre (`secret_id`). O texto do bloco não tem como ler a chave —
 *    não há namespace `{{segredo...}}` —, e o publish recusa quem tenta;
 *  - a chave nunca vai na URL (nem na query): API key em query string vaza em
 *    log de proxy e de servidor de quem recebe;
 *  - o que a resposta devolve vira variável da execução em `{{saida.<nome>}}`
 *    (o namespace `saida` já era reservado no `fieldRef` de variável, então uma
 *    Condição lê `saida.<nome>` sem mudança de contrato).
 */
import { z } from "zod";

import { fieldRefSchema, tpl } from "./schemas";

export const METODOS_HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type MetodoHttp = (typeof METODOS_HTTP)[number];

/** Tempo limite padrão e teto de uma chamada (o motor não espera mais que isso). */
export const TEMPO_LIMITE_PADRAO_MS = 10_000;
export const TEMPO_LIMITE_MINIMO_MS = 1_000;
export const TEMPO_LIMITE_MAXIMO_MS = 30_000;

/** Teto da URL, do valor de cabeçalho e do corpo (antes de preencher as variáveis). */
export const MAX_URL = 2000;
export const MAX_VALOR_DE_CABECALHO = 1000;
export const MAX_CORPO = 16_000;
export const MAX_CABECALHOS = 20;
export const MAX_MAPEAMENTOS = 20;
/** Cada valor guardado da resposta é cortado neste tamanho (caracteres). */
export const MAX_VALOR_MAPEADO = 500;
/**
 * Teto do namespace `saida` inteiro, em bytes de JSON. `followup_enrollments.vars`
 * tem CHECK de 64 KB (migration 0986) e guarda também o gatilho e as respostas:
 * o `saida` fica com no máximo um quarto disso.
 */
export const MAX_BYTES_DA_SAIDA = 16_384;

/** Nome de cabeçalho HTTP: letras, números e hífen. */
export const NOME_DE_CABECALHO = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Cabeçalhos que o bloco NÃO deixa definir. Os de transporte (`Host`,
 * `Content-Length`, `Transfer-Encoding`, `Connection`...) desmontariam a
 * requisição ou o destino validado; `Cookie` e `Proxy-Authorization` não têm uso
 * legítimo numa chamada de servidor para servidor. Comparação sem maiúsculas.
 */
export const CABECALHOS_PROIBIDOS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "accept-encoding",
  "cookie",
  "proxy-authorization",
  "proxy-connection",
]);

export function cabecalhoProibido(nome: string): boolean {
  return CABECALHOS_PROIBIDOS.has(nome.trim().toLowerCase());
}

/** Nome da variável guardada da resposta: `{{saida.<nome>}}`. */
export const NOME_DA_VARIAVEL_DE_SAIDA = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Caminho no JSON da resposta: `campaign.name`, `data[0].id`, `items[2]`.
 * Sem curinga e sem expressão — o caminho só desce.
 */
export const CAMINHO_NO_JSON = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+|\[\d{1,4}\])*$/;

/** O texto que tenta ler uma chave secreta por variável — recusado em todo texto do bloco. */
export const TENTATIVA_DE_SEGREDO = /\{\{\s*(segredo|segredos|secret|secrets|chave|chaves)\b/i;

const uuid = z.string().uuid();

export const cabecalhoHttpSchema = z.discriminatedUnion("kind", [
  /** Valor digitado (aceita variáveis `{{...}}`). */
  z.strictObject({
    kind: z.literal("texto"),
    name: z.string().regex(NOME_DE_CABECALHO, "Use letras, números e hífen"),
    value: tpl(MAX_VALOR_DE_CABECALHO),
  }),
  /**
   * Valor vindo do cofre: `prefix` + a chave (ex.: `Bearer ` + token). O grafo
   * guarda só o id da chave; o servidor a decifra na hora do envio.
   */
  z.strictObject({
    kind: z.literal("chave"),
    name: z.string().regex(NOME_DE_CABECALHO, "Use letras, números e hífen"),
    secret_id: uuid,
    prefix: z
      .string()
      .max(40)
      .regex(/^[\x20-\x7e]*$/, "Use só letras, números e símbolos simples"),
  }),
]);
export type CabecalhoHttp = z.infer<typeof cabecalhoHttpSchema>;

export const mapeamentoHttpSchema = z
  .strictObject({
    /** Onde está o valor no JSON da resposta. */
    path: z.string().max(200).regex(CAMINHO_NO_JSON, "Use o caminho com pontos, como campaign.name"),
    /** Nome da variável: `{{saida.<var>}}` nos blocos seguintes. */
    var: z.string().regex(NOME_DA_VARIAVEL_DE_SAIDA, "Use letras minúsculas, números e underscore"),
    /** Opcional: grava também neste campo do negócio ou do contato (a mesma escrita da operação de campo). */
    to: fieldRefSchema.optional(),
  })
  .refine((m) => m.to === undefined || m.to.scope !== "var", {
    message: "variável é só leitura",
    path: ["to"],
  });
export type MapeamentoHttp = z.infer<typeof mapeamentoHttpSchema>;

export const httpRequestConfigSchema = z
  .strictObject({
    method: z.enum(METODOS_HTTP),
    url: tpl(MAX_URL).min(1),
    headers: z.array(cabecalhoHttpSchema).max(MAX_CABECALHOS),
    /** Corpo JSON (com variáveis dentro das aspas). Ausente = sem corpo. */
    body: tpl(MAX_CORPO).optional(),
    timeout_ms: z.number().int().min(TEMPO_LIMITE_MINIMO_MS).max(TEMPO_LIMITE_MAXIMO_MS),
    mappings: z.array(mapeamentoHttpSchema).max(MAX_MAPEAMENTOS),
  })
  .refine((c) => new Set(c.mappings.map((m) => m.var)).size === c.mappings.length, {
    message: "nome de variável repetido",
    path: ["mappings"],
  });
export type HttpRequestConfig = z.infer<typeof httpRequestConfigSchema>;

/** A config com que o bloco nasce no editor (válida no schema; o publish cobra a URL). */
export function configHttpEmBranco(): HttpRequestConfig {
  return { method: "GET", url: "https://", headers: [], timeout_ms: TEMPO_LIMITE_PADRAO_MS, mappings: [] };
}

/** As chaves do cofre que o bloco cita. */
export function segredosDoBloco(config: Pick<HttpRequestConfig, "headers">): string[] {
  return [...new Set(config.headers.flatMap((h) => (h.kind === "chave" ? [h.secret_id] : [])))];
}

/** Método que leva corpo. GET não leva (muitos servidores recusam). */
export function metodoTemCorpo(metodo: MetodoHttp): boolean {
  return metodo !== "GET";
}

/**
 * O corpo como modelo JSON: tem de ser JSON válido COM as variáveis dentro de
 * aspas (`{"nome": "{{contact.name}}"}`). Assim o valor preenchido é escapado
 * pelo `JSON.stringify` e nunca quebra o JSON nem injeta campo.
 */
export function corpoEhJsonValido(corpo: string): boolean {
  try {
    JSON.parse(corpo);
    return true;
  } catch {
    return false;
  }
}

/** Preenche as variáveis em cada TEXTO do JSON (chaves e valores), já como objeto. */
export function preencherCorpoJson(corpo: string, preencher: (texto: string) => string): unknown {
  const desce = (v: unknown): unknown => {
    if (typeof v === "string") return preencher(v);
    if (Array.isArray(v)) return v.map(desce);
    if (v && typeof v === "object") {
      const saida: Record<string, unknown> = {};
      for (const [k, valor] of Object.entries(v as Record<string, unknown>)) saida[preencher(k)] = desce(valor);
      return saida;
    }
    return v;
  };
  return desce(JSON.parse(corpo));
}

/**
 * Lê o valor no caminho. Só propriedade PRÓPRIA (`constructor`, `__proto__`
 * não sobem pelo protótipo). `undefined` quando o caminho não existe.
 */
export function lerCaminhoNoJson(raiz: unknown, caminho: string): unknown {
  if (!CAMINHO_NO_JSON.test(caminho)) return undefined;
  let atual: unknown = raiz;
  for (const parte of caminho.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== "")) {
    if (atual === null || typeof atual !== "object") return undefined;
    if (Array.isArray(atual)) {
      if (!/^\d+$/.test(parte)) return undefined;
      atual = atual[Number(parte)];
      continue;
    }
    if (!Object.hasOwn(atual, parte)) return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

/** O valor lido como texto: número e sim/não viram texto; objeto e lista, JSON. `null` = não há valor. */
export function valorComoTexto(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  try {
    return JSON.stringify(valor);
  } catch {
    return null;
  }
}

export const MASCARA = "••••";

/**
 * Troca toda ocorrência de cada chave secreta por `••••`. Vale para tudo que
 * sai da chamada e é gravado (valor mapeado, caminho do log): o servidor de
 * destino pode ECOAR o token na resposta. Chave curta demais (menos de 4
 * caracteres) também é mascarada — o cofre exige no mínimo 8, então isso só
 * protege contra dado antigo.
 */
export function mascararSegredos(texto: string, segredos: readonly string[]): string {
  let saida = texto;
  // A mais longa primeiro: uma chave que contém outra não sobra pela metade.
  for (const s of [...segredos].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) {
    saida = saida.split(s).join(MASCARA);
  }
  return saida;
}

/** Os 4 últimos caracteres que a tela mostra (`••••1234`). */
export function ultimos4(valor: string): string {
  return valor.slice(-4);
}

/** Por que esta URL (ainda com as variáveis) não serve — ou `null`. Só o que dá para julgar sem rede. */
export function problemaDaUrl(url: string): "vazia" | "segredo_na_url" | "invalida" | "https_obrigatorio" | "credencial_na_url" | null {
  const u = url.trim();
  if (!u || u === "https://") return "vazia";
  if (TENTATIVA_DE_SEGREDO.test(u)) return "segredo_na_url";
  // As variáveis viram texto de exemplo para conferir a forma.
  let parsed: URL;
  try {
    parsed = new URL(u.replace(/\{\{[^}]*\}\}/g, "x"));
  } catch {
    return "invalida";
  }
  if (parsed.protocol !== "https:") return "https_obrigatorio";
  if (parsed.username || parsed.password) return "credencial_na_url";
  if (!parsed.hostname || parsed.hostname === "x") return "invalida";
  return null;
}
