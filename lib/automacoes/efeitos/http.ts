/**
 * O EFEITO do bloco "Requisição HTTP" (lote 4): chama a URL, guarda o que a
 * resposta devolve em `{{saida.<nome>}}` (e, se pedido, num campo do negócio ou
 * do contato) e escolhe a saída "Deu certo" (2xx) ou "Falhou".
 *
 * Segurança — a mesma cadeia do cliente MCP externo (`criarFetchSeguro`):
 *  - https sempre (destino escolhido por ORGANIZAÇÃO), guarda textual
 *    (`assertSafeOutboundUrl`: localhost, 127., 10., 192.168., 169.254., 172.16/12,
 *    IPv6 literal) e guarda por IP resolvido (`resolverDestinoSeguro`), com a
 *    conexão aberta NO IP validado (sem janela de DNS rebinding);
 *  - redirecionamento nunca é seguido (3xx = Falhou);
 *  - resposta com teto de bytes (`TETO_DE_BYTES`, 2 MiB);
 *  - tempo limite do bloco (padrão 10 s, máximo 30 s).
 * A chave do cofre é decifrada aqui, na hora, e só vai no cabeçalho. Ela nunca
 * entra no detalhe do evento, no log, na mensagem de erro nem nas variáveis:
 * todo texto que sai daqui é mascarado (`mascararSegredos`) — o servidor de
 * destino pode ECOAR o token na resposta.
 *
 * Sem retentativa no v1: o motor roda o efeito no máximo uma vez por nó+passo
 * (`effect_started`/`effect_done`, `resolverEfeito` em engine.ts). Tick que caiu
 * no meio da chamada sai por "Falhou" (`efeito_interrompido`) em vez de chamar
 * de novo — o outro sistema pode não ser idempotente. Para isso não acontecer
 * por lease vencido, o motor só começa a chamada quando o lease ainda cobre o
 * tempo limite do bloco (`leaseCobreOHttp` em engine.ts).
 *
 * Tetos: `TETO_DE_CHAMADAS_POR_MINUTO` por organização (o mesmo contador por
 * janela do despacho de IA, Redis com recuo para memória) e
 * `MAX_HTTP_POR_EXECUCAO` por execução (conferido no motor).
 */
import { codigoParaOrganizacao } from "@/lib/automation/destino-recusado";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { renderTemplate } from "@/lib/automation/template";
import { checkRateLimit, type RateLimitResult } from "@/lib/ai/dispatcher/rate-limit";
import { criarFetchSeguro } from "@/lib/ai/mcp-externo/fetch-seguro";
import type { ResultadoDoEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import { logger } from "@/lib/logger";

import {
  cabecalhoComSegredoEscrito,
  cabecalhoProibido,
  lerCaminhoNoJson,
  mascararSegredos,
  MAX_BYTES_DA_SAIDA,
  MAX_VALOR_MAPEADO,
  metodoTemCorpo,
  porNoCaminhoDoCorpo,
  preencherCorpoJson,
  segredosDoBloco,
  TENTATIVA_DE_SEGREDO,
  valorComoTexto,
  variavelNaAutoridade,
} from "../http";
import type { FieldOp } from "../schemas";
import { lerValoresDosSegredos, marcarUsoDosSegredos } from "../segredos";
import { contextoDoTemplate } from "../template-vars";
import type { Contexto, Passo } from "./index";

export type NoHttp = Extract<FlowNode, { type: "http_request" }>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DepsDoHttp {
  /** Teste: troca a rede (o padrão é o fetch seguro de produção). */
  fetch?: FetchLike;
  /** Grava nos campos (a mesma escrita da operação de campo). */
  gravarCampos: (ops: FieldOp[]) => Promise<Passo>;
  /** Teste: troca o contador por janela (o padrão é `checkRateLimit`). */
  limitar?: (
    bucket: string,
    teto: number,
    janelaSeg: number,
  ) => Promise<Pick<RateLimitResult, "allowed">>;
}

/** Chamadas HTTP por organização por minuto (todas as automações somadas). */
export const TETO_DE_CHAMADAS_POR_MINUTO = 120;

/**
 * Separa o modelo da URL em origem (`https://host:porta`, sem variável — o
 * publish e o motor recusam variável ali), caminho e o resto (`?query#frag`).
 */
function partesDoModelo(modelo: string): { origem: string; caminho: string; resto: string } {
  const u = modelo.trim();
  const esquema = /^[a-z][a-z0-9+.-]*:\/\//i.exec(u)?.[0] ?? "";
  const depois = u.slice(esquema.length);
  const fimDaOrigem = depois.search(/[/?#]/);
  const origem = esquema + (fimDaOrigem === -1 ? depois : depois.slice(0, fimDaOrigem));
  const aposOrigem = fimDaOrigem === -1 ? "" : depois.slice(fimDaOrigem);
  const fimDoCaminho = aposOrigem.search(/[?#]/);
  return {
    origem,
    caminho: fimDoCaminho === -1 ? aposOrigem : aposOrigem.slice(0, fimDoCaminho),
    resto: fimDoCaminho === -1 ? "" : aposOrigem.slice(fimDoCaminho),
  };
}

/** Quantos segmentos o caminho tem (`/v1/x` = 2). As variáveis do modelo contam como um segmento cada. */
function segmentos(caminho: string): number {
  return caminho === "" ? 0 : caminho.split("/").length - 1;
}

/** Segmentos vazios (`//`, ou `/` no fim). Um valor vazio que some com um segmento muda esta conta. */
function vazios(caminho: string): number {
  return caminho
    .split("/")
    .slice(1)
    .filter((x) => x === "").length;
}

/** O código de erro legível (vocabulário: `ERROS_DO_EFEITO`) para o que a guarda ou a rede devolveu. */
export function codigoDaFalhaDeRede(err: unknown): string {
  const nome = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (nome === "TimeoutError" || nome === "AbortError" || /aborted|timeout/i.test(msg))
    return "http_tempo_esgotado";
  if (msg === "unsafe_url:https_required") return "http_https_obrigatorio";
  if (msg === "unsafe_url:invalid" || msg === "unsafe_url:scheme") return "http_url_invalida";
  if (msg.startsWith("unsafe_url:")) return "http_destino_recusado";
  if (msg === "mcp_redirecionamento_recusado") return "http_redirecionamento";
  if (msg === "mcp_resposta_grande_demais") return "http_resposta_grande";
  return "http_falha_de_rede";
}

function falha(erro: string, detalhe: Record<string, unknown>): ResultadoDoEfeito {
  return {
    desfecho: { ok: false, erro },
    detalhes: [{ tipo: "http_request", ok: false, erro, ...detalhe }],
  };
}

export async function executarHttp(
  c: Contexto,
  node: NoHttp,
  deps: DepsDoHttp,
): Promise<ResultadoDoEfeito> {
  const cfg = node.config;
  const contexto = contextoDoTemplate(c.fatos, c.agora);
  const base: Record<string, unknown> = { metodo: cfg.method };

  // 1. A URL: nunca com chave; nunca variável no domínio (nem na porta). Cada
  // valor preenchido vai codificado — `encodeURIComponent` troca `/`, `?` e `#`,
  // mas NÃO `.`: um valor `..` subiria um nível no caminho. Por isso o valor `.`
  // ou `..` no CAMINHO é recusado, e o caminho renderizado tem de ter os mesmos
  // segmentos (e os mesmos segmentos vazios) que o modelo.
  if (TENTATIVA_DE_SEGREDO.test(cfg.url)) return falha("http_segredo_na_url", base);
  if (variavelNaAutoridade(cfg.url)) return falha("http_url_invalida", base);
  const modelo = partesDoModelo(cfg.url);
  let caminhoTorto = false;
  const caminhoPreenchido = renderTemplate(modelo.caminho, contexto, (v) => {
    if (v === "." || v === "..") caminhoTorto = true;
    return encodeURIComponent(v);
  });
  const url = (
    modelo.origem +
    caminhoPreenchido +
    renderTemplate(modelo.resto, contexto, encodeURIComponent)
  ).trim();
  // O que o evento guarda: host e caminho do MODELO (com as `{{...}}`), nunca o
  // valor preenchido (pode ser dado do contato) nem a query.
  let alvoDoModelo: URL;
  let alvo: URL;
  try {
    alvoDoModelo = new URL(modelo.origem);
    alvo = new URL(url);
  } catch {
    return falha("http_url_invalida", base);
  }
  Object.assign(base, { host: alvoDoModelo.host, caminho: modelo.caminho.slice(0, 200) });
  if (caminhoTorto) return falha("http_url_invalida", base);
  if (alvo.username || alvo.password) return falha("http_url_invalida", base);
  // O destino tem de ser EXATAMENTE o do modelo (host e porta) antes de anexar a chave.
  if (alvo.host !== alvoDoModelo.host || alvo.protocol !== alvoDoModelo.protocol)
    return falha("http_url_invalida", base);
  // `..` que sobrou de reserva, ou segmento esvaziado: o caminho não é o que o modelo diz.
  const esperado = modelo.caminho === "" ? 1 : segmentos(modelo.caminho);
  if (
    segmentos(alvo.pathname) !== esperado ||
    vazios(caminhoPreenchido) !== vazios(modelo.caminho)
  ) {
    return falha("http_url_invalida", base);
  }

  // 2. As chaves do cofre, desta organização.
  const ids = segredosDoBloco(cfg);
  const { valores, inexistentes, indisponiveis } = await lerValoresDosSegredos(c.admin, c.org, ids);
  const segredos = [...valores.values()];
  const prefixos = [
    ...cfg.headers.flatMap((h) => (h.kind === "chave" ? [h.prefix] : [])),
    ...(cfg.body_secrets ?? []).map((b) => b.prefix),
  ];
  const mascarar = (t: string) => mascararSegredos(t, segredos, prefixos);
  if (inexistentes.length > 0) return falha("segredo_inexistente", base);
  if (indisponiveis.length > 0) return falha("segredo_indisponivel", base);

  try {
    assertSafeOutboundUrl(url, { httpsSempre: true });
  } catch (err) {
    const codigo = err instanceof Error ? err.message : String(err);
    logger.warn("[automacao.http] destino recusado", { motivo: codigo, pointer_id: c.pointerId });
    return falha(codigoDaFalhaDeRede(new Error(codigoParaOrganizacao(codigo))), base);
  }

  // 3. Cabeçalhos.
  const headers = new Headers();
  for (const h of cfg.headers) {
    if (cabecalhoProibido(h.name))
      return falha("http_cabecalho_proibido", { ...base, cabecalho: h.name });
    // Credencial escrita no grafo (legível por toda a organização): só chave do cofre.
    if (cabecalhoComSegredoEscrito(h))
      return falha("http_segredo_no_texto", { ...base, cabecalho: h.name });
    const valor =
      h.kind === "chave"
        ? `${h.prefix}${valores.get(h.secret_id) ?? ""}`
        : TENTATIVA_DE_SEGREDO.test(h.value)
          ? null
          : renderTemplate(h.value, contexto);
    if (valor === null) return falha("http_segredo_no_texto", base);
    if (/[\r\n\0]/.test(valor))
      return falha("http_cabecalho_invalido", { ...base, cabecalho: h.name });
    try {
      headers.set(h.name, valor);
    } catch {
      return falha("http_cabecalho_invalido", { ...base, cabecalho: h.name });
    }
  }

  // 4. Corpo JSON (variáveis só dentro das aspas, escapadas pelo stringify).
  let corpo: string | undefined;
  if (cfg.body !== undefined && cfg.body.trim() !== "" && metodoTemCorpo(cfg.method)) {
    if (TENTATIVA_DE_SEGREDO.test(cfg.body)) return falha("http_segredo_no_texto", base);
    let objeto: unknown;
    try {
      objeto = preencherCorpoJson(cfg.body, (t) => renderTemplate(t, contexto));
    } catch {
      return falha("http_corpo_invalido", base);
    }
    // A chave do cofre entra DEPOIS do preenchimento, no campo de texto escolhido.
    for (const b of cfg.body_secrets ?? []) {
      if (!porNoCaminhoDoCorpo(objeto, b.path, `${b.prefix}${valores.get(b.secret_id) ?? ""}`)) {
        return falha("http_corpo_invalido", base);
      }
    }
    corpo = JSON.stringify(objeto);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  // 5. O teto da organização (por minuto), e a chamada.
  const limitar = deps.limitar ?? checkRateLimit;
  let cabe: boolean;
  try {
    cabe = (await limitar(`automacao-http:${c.org}`, TETO_DE_CHAMADAS_POR_MINUTO, 60)).allowed;
  } catch {
    cabe = false;
  }
  if (!cabe) return falha("http_limite_atingido", base);
  const buscar = deps.fetch ?? criarFetchSeguro();
  const inicio = Date.now();
  let status: number;
  let texto: string;
  try {
    const res = await buscar(url, {
      method: cfg.method,
      headers,
      ...(corpo !== undefined ? { body: corpo } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
    status = res.status;
    if (status >= 300 && status < 400) {
      await res.body?.cancel().catch(() => {});
      return falha("http_redirecionamento", { ...base, status, duracao_ms: Date.now() - inicio });
    }
    texto = await res.text();
  } catch (err) {
    const codigo = codigoDaFalhaDeRede(err);
    // Só o código: a mensagem crua pode trazer a URL com dado do contato.
    logger.warn("[automacao.http] chamada falhou", {
      codigo,
      motivo:
        err instanceof Error && err.message.startsWith("unsafe_url:") ? err.message : undefined,
      pointer_id: c.pointerId,
    });
    return falha(codigo, { ...base, duracao_ms: Date.now() - inicio });
  }
  const duracao = Date.now() - inicio;
  await marcarUsoDosSegredos(c.admin, c.org, ids, c.agora);
  if (status < 200 || status >= 300) {
    return falha(`http_status:${status}`, { ...base, status, duracao_ms: duracao });
  }

  // 6. Mapeamentos: caminho no JSON → `{{saida.<nome>}}` (e, se pedido, campo).
  let json: unknown = undefined;
  if (cfg.mappings.length > 0) {
    try {
      json = JSON.parse(texto);
    } catch {
      return falha("http_resposta_nao_json", { ...base, status, duracao_ms: duracao });
    }
  }
  const novas: Record<string, string> = {};
  const ausentes: string[] = [];
  const ops: FieldOp[] = [];
  for (const m of cfg.mappings) {
    const bruto = valorComoTexto(lerCaminhoNoJson(json, m.path));
    if (bruto === null) {
      ausentes.push(m.var);
      continue;
    }
    const valor = mascarar(bruto).slice(0, MAX_VALOR_MAPEADO);
    novas[m.var] = valor;
    if (m.to) ops.push({ target: m.to, op: "set", value: valor } as FieldOp);
  }
  const anteriores = (c.vars?.saida as Record<string, unknown> | undefined) ?? {};
  const saida = { ...anteriores, ...novas };
  if (new TextEncoder().encode(JSON.stringify(saida)).length > MAX_BYTES_DA_SAIDA) {
    return falha("http_saida_grande", { ...base, status, duracao_ms: duracao });
  }
  const detalhe = {
    tipo: "http_request",
    ...base,
    status,
    duracao_ms: duracao,
    campos: Object.keys(novas),
    ...(ausentes.length > 0 ? { ausentes } : {}),
  };
  if (ops.length > 0) {
    let gravou: Passo;
    try {
      gravou = await deps.gravarCampos(ops);
    } catch {
      gravou = { ok: false, erro: "efeito_falhou", detalhe: { tipo: "field_op" } };
    }
    if (!gravou.ok) {
      return {
        desfecho: { ok: false, erro: gravou.erro ?? "efeito_falhou" },
        vars: { saida },
        detalhes: [{ ...detalhe, ok: false, erro: gravou.erro ?? "efeito_falhou" }],
      };
    }
  }
  return { desfecho: { ok: true }, vars: { saida }, detalhes: [{ ...detalhe, ok: true }] };
}
