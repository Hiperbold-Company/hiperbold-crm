/**
 * Parsing do inbound de captação: field_map → lead normalizado + HMAC.
 * Sem I/O — puro, testável. A rota (webhooks/in/[token]) faz o resto.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { cnpjValido, cpfValido, somenteDigitos } from "@/lib/documentos/cpf-cnpj";
import type {
  AtribuicaoDeAnuncio,
  PlataformaDeAnuncio,
} from "@/lib/leads/atribuicao-de-anuncio";

export interface FieldMap {
  name?: string[];
  phone?: string[];
  email?: string[];
}

const DEFAULT_FIELD_MAP: Required<FieldMap> = {
  name: ["name", "nome", "full_name", "fullname"],
  phone: ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"],
  email: ["email", "e-mail", "mail"],
};

/**
 * Chaves que a PLATAFORMA do formulário põe no envio e que não são resposta de
 * ninguém. O JetFormBuilder manda `__refer`, `__form_id` e `__is_ajax` junto com
 * os campos do formulário (medido num envio real, 2026-09-30); o WordPress
 * acrescenta nonce e referer. Entrando em `custom_fields`, apareciam no card do
 * lead como se a pessoa as tivesse preenchido.
 *
 * Lista NOMEADA, e não "tudo que começa com `_`": um formulário próprio pode ter
 * um campo legítimo chamado `_origem`, e descartá-lo em silêncio seria perder
 * dado de cliente. Só cai o que é conhecidamente da plataforma.
 */
export const CHAVES_DE_PLATAFORMA = new Set([
  "__refer",
  "__form_id",
  "__is_ajax",
  "__queried_post_id",
  "_wpnonce",
  "_wp_http_referer",
  "_jet_engine_refer",
  "_jet_engine_booking_form_id",
  "jfb_preview_nonce",
  "_jfb_current_render_states",
  "_jfb_current_render_states[]",
]);

/**
 * As chaves com que uma PLATAFORMA DE ANÚNCIO marca o clique que trouxe a pessoa
 * (issue #2317).
 *
 * Quem anuncia para uma landing page com FORMULÁRIO manda `fbclid`, `fbc`,
 * `fbp`, `gclid`, `ad_id`, `adset_id` e `campaign_id` no envio. Até aqui elas
 * caíam em `custom_fields` — apareciam no card do lead como se a pessoa as
 * tivesse preenchido — e a origem do anúncio se perdia: `lib/conversoes`, que lê
 * a atribuição do contato, não sabia de que clique veio uma venda de formulário.
 *
 * RESERVADAS, e por isso seguem o MESMO caminho do `utm_*`: vão para
 * `source_metadata`, de onde a atribuição do contato é estampada
 * (`extrairAtribuicaoDoInbound`) com a guarda de primeiro toque que o
 * clique-pro-WhatsApp já usa.
 *
 * Lista NOMEADA e FECHADA, como `CHAVES_DE_PLATAFORMA`: um formulário próprio
 * pode ter um campo legítimo chamado `campaign` ou `origem`, e não é trabalho
 * deste módulo adivinhar. Só o que é conhecidamente identificador de anúncio cai
 * aqui. Os identificadores só-iOS (`gbraid`/`wbraid`) ficam de fora enquanto um
 * formulário real não os mandar.
 *
 * ─── Uma lista só, três mapeadores (issue #3149) ───────────────────────────
 *
 * Quem lê esta lista são os TRÊS caminhos de entrada, e não só o genérico: o
 * genérico (`mapInboundPayload`) e os dedicados de terceiro (`elementor.ts`,
 * `rdstation.ts`, `respondi.ts`), que só mudam ONDE procurar a chave — cada um
 * na forma do seu fornecedor — e entregam em `source_metadata` do mesmo jeito.
 * Fornecedor novo entra por aqui, não com uma lista própria.
 */
export const CHAVES_DE_ANUNCIO: ReadonlySet<string> = new Set([
  "fbclid",
  "fbc",
  "fbp",
  "gclid",
  "ad_id",
  "adset_id",
  "campaign_id",
]);

export interface MappedLead {
  name: string | null;
  phone: string | null;
  email: string | null;
  custom_fields: Record<string, string>;
  source_metadata: Record<string, string>;
}

/**
 * Normaliza telefone BR para E.164 com o nono dígito no celular.
 *
 * Prefixos de tronco (`0` do DDD nacional, `00` da chamada internacional) saem
 * ANTES das regras de tamanho: "011 99999-0000" tem 12 dígitos e era lido como
 * número com DDI, e "0055 11 ..." nem batia nas faixas. Com `+`, o número já é
 * internacional e precisa de pelo menos 10 dígitos (E.164 real mais curto): um
 * "+123" não é telefone e antes virava contato.
 */
export function normalizePhoneBR(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const digits = raw.replace(/\D/g, "");
  let e164: string | null = null;
  if (raw.trim().startsWith("+")) {
    e164 = /^[1-9]\d{9,14}$/.test(digits) ? `+${digits}` : null;
  } else {
    const semTronco = digits.replace(/^0+/, "");
    if (semTronco.length === 12 || semTronco.length === 13) {
      e164 = semTronco.startsWith("55") ? `+${semTronco}` : null;
    } else if (semTronco.length === 10 || semTronco.length === 11) {
      e164 = `+55${semTronco}`;
    }
  }
  return e164 ? canonicalPhoneBR(e164) : null;
}

/**
 * O corpo JSON de um envio: o objeto, ou o motivo de não ser um. `null`, número,
 * texto e lista são JSON válido que a rota tratava como payload: `null` fazia
 * `Object.entries(null)` lançar (500) e o resto virava envio sem campos.
 */
export function lerCorpoJsonObjeto(rawBody: string): Record<string, unknown> | "json_invalido" | "nao_objeto" {
  if (!rawBody) return {};
  let valor: unknown;
  try {
    valor = JSON.parse(rawBody);
  } catch {
    return "json_invalido";
  }
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) return "nao_objeto";
  return valor as Record<string, unknown>;
}

// ─── Campos RESERVADOS do envio (decisão do dono do produto, 17/10/2026) ───────
//
// `tags` e `cpf` não são dado livre do formulário: têm destino próprio (a coluna
// `crm_leads.tags` e o par cifrado `contacts.cpf_encrypted`/`cpf_hash`) e por isso
// NUNCA viram campo personalizado. Casam por chave sem diferenciar caixa.

/** Quantas etiquetas um único envio pode pôr; o que passa disso é descartado. */
export const MAX_TAGS_POR_ENVIO = 20;
/** Tamanho máximo de cada etiqueta (o mesmo teto do lead); o que passa é cortado. */
export const MAX_CARACTERES_DA_TAG = 60;
/** Teto de etiquetas de um lead depois de unir as do recadastro (o mesmo do schema do lead). */
export const MAX_TAGS_DO_LEAD = 50;

const CHAVES_DE_TAGS = new Set(["tags", "tags[]"]);
const CHAVES_DE_CPF = new Set(["cpf", "cpf_cnpj"]);

function ehChaveReservada(chave: string): boolean {
  const k = chave.toLowerCase();
  return CHAVES_DE_TAGS.has(k) || CHAVES_DE_CPF.has(k);
}

/**
 * Etiquetas do envio: lista de textos, ou um texto separado por `,` ou `|`.
 * Apara, descarta o vazio, corta cada uma em 60 caracteres, tira repetida SEM
 * diferenciar caixa (a primeira grafia vence, a caixa original é preservada) e
 * para em 20.
 */
export function parseTagsReservadas(valor: unknown): string[] {
  const pedacos: string[] = [];
  const juntar = (v: unknown): void => {
    if (typeof v === "string") pedacos.push(...v.split(/[,|]/));
    else if (typeof v === "number") pedacos.push(String(v));
  };
  if (Array.isArray(valor)) valor.forEach(juntar);
  else juntar(valor);

  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const crua of pedacos) {
    const tag = crua.trim().slice(0, MAX_CARACTERES_DA_TAG).trim();
    if (tag === "") continue;
    const chave = tag.toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(tag);
    if (saida.length >= MAX_TAGS_POR_ENVIO) break;
  }
  return saida;
}

/** As etiquetas reservadas do payload (chave `tags` ou `tags[]`, caixa livre). */
export function lerTagsReservadas(payload: Record<string, unknown>): string[] {
  const juntas: unknown[] = [];
  for (const [chave, valor] of Object.entries(payload)) {
    if (!CHAVES_DE_TAGS.has(chave.toLowerCase())) continue;
    if (Array.isArray(valor)) juntas.push(...valor);
    else juntas.push(valor);
  }
  return parseTagsReservadas(juntas);
}

/**
 * União das etiquetas que o lead já tem com as do envio: as existentes ficam
 * como estão (e na ordem), as novas entram no fim, sem repetir nenhuma que já
 * exista com outra caixa. Devolve só o que foi ACRESCENTADO, para o evento.
 */
export function mesclarTags(
  existentes: readonly string[],
  novas: readonly string[],
): { tags: string[]; adicionadas: string[] } {
  const tags = [...existentes];
  const vistas = new Set(existentes.map((t) => t.toLowerCase()));
  const adicionadas: string[] = [];
  for (const nova of novas) {
    if (tags.length >= MAX_TAGS_DO_LEAD) break;
    const chave = nova.toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    tags.push(nova);
    adicionadas.push(nova);
  }
  return { tags, adicionadas };
}

export type DocumentoDoEnvio =
  | { estado: "ausente" }
  | { estado: "cpf"; cpf: string }
  | { estado: "descartado"; motivo: "cnpj" | "invalido" };

/**
 * O documento do envio (`cpf`, alias `cpf_cnpj`). Só CPF com dígito verificador
 * correto é aceito; CNPJ e qualquer outra coisa são descartados — e o descarte é
 * silencioso para quem enviou. O valor NUNCA sai daqui em mensagem de erro.
 */
export function lerDocumentoReservado(payload: Record<string, unknown>): DocumentoDoEnvio {
  let visto = false;
  let motivo: "cnpj" | "invalido" = "invalido";
  for (const [chave, valor] of Object.entries(payload)) {
    if (!CHAVES_DE_CPF.has(chave.toLowerCase())) continue;
    let texto: string | null = null;
    if (typeof valor === "string") texto = valor;
    // Número JSON perde o zero à esquerda: devolve ao tamanho de CPF.
    else if (typeof valor === "number" && Number.isInteger(valor) && valor > 0) texto = String(valor).padStart(11, "0");
    if (texto === null || texto.trim() === "") continue;
    visto = true;
    const digitos = somenteDigitos(texto);
    if (digitos.length === 11 && cpfValido(digitos)) return { estado: "cpf", cpf: digitos };
    if (digitos.length === 14 && cnpjValido(digitos)) motivo = "cnpj";
  }
  return visto ? { estado: "descartado", motivo } : { estado: "ausente" };
}

/**
 * Tira o documento do payload (muta) para que ele NÃO chegue a nenhum registro:
 * log de recebimento, histórico de captação, campo personalizado. Devolve se
 * havia alguma chave de documento — quem precisa regravar o corpo cru sabe então
 * que tem de limpá-lo também.
 */
export function removerDocumentoDoPayload(payload: Record<string, unknown>): boolean {
  let havia = false;
  for (const chave of Object.keys(payload)) {
    if (CHAVES_DE_CPF.has(chave.toLowerCase())) {
      delete payload[chave];
      havia = true;
    }
  }
  return havia;
}

/** O corpo cru SEM as chaves de documento (e as extras, como o token do Turnstile), para o log forense. */
export function corpoSemDocumento(
  rawBody: string,
  ehFormulario: boolean,
  payloadLimpo: Record<string, unknown>,
  tambemRemover: readonly string[] = [],
): string {
  if (!ehFormulario) return JSON.stringify(payloadLimpo);
  const params = new URLSearchParams(rawBody);
  const extras = new Set(tambemRemover.map((c) => c.toLowerCase()));
  for (const chave of [...new Set([...params.keys()])]) {
    if (CHAVES_DE_CPF.has(chave.toLowerCase()) || extras.has(chave.toLowerCase())) params.delete(chave);
  }
  return params.toString();
}

/**
 * Form-urlencoded para objeto. Chave repetida vale o último valor — exceto as
 * de etiqueta (`tags` / `tags[]`), que se juntam numa lista: é assim que um
 * formulário com vários marcadores envia.
 */
export function payloadDeFormulario(rawBody: string): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of new URLSearchParams(rawBody)) {
    if (CHAVES_DE_TAGS.has(chave.toLowerCase())) {
      const anterior = saida["tags"];
      saida["tags"] = Array.isArray(anterior) ? [...anterior, valor] : [valor];
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

/**
 * A chave é de anúncio? Normaliza a chave do payload (é o que os mapeadores
 * dedicados precisam chamar quando o identificador do campo deles é livre — o
 * `id` do Elementor, o rótulo da pergunta do Respondi).
 */
export function ehChaveDeAnuncio(chave: string): boolean {
  return CHAVES_DE_ANUNCIO.has(chave.trim().toLowerCase());
}

function firstMatch(payload: Record<string, unknown>, aliases: string[]): { key: string; value: string } | null {
  const lowered = new Map(Object.keys(payload).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases) {
    const key = lowered.get(alias.toLowerCase());
    if (key !== undefined) {
      const v = payload[key];
      if (typeof v === "string" && v.trim()) return { key, value: v.trim() };
    }
  }
  return null;
}

export function mapInboundPayload(
  payload: Record<string, unknown>,
  fieldMap: FieldMap = {},
): MappedLead {
  const map: Required<FieldMap> = {
    name: [...(fieldMap.name ?? []), ...DEFAULT_FIELD_MAP.name],
    phone: [...(fieldMap.phone ?? []), ...DEFAULT_FIELD_MAP.phone],
    email: [...(fieldMap.email ?? []), ...DEFAULT_FIELD_MAP.email],
  };

  const nameHit = firstMatch(payload, map.name);
  const phoneHit = firstMatch(payload, map.phone);
  const emailHit = firstMatch(payload, map.email);
  const consumed = new Set([nameHit?.key, phoneHit?.key, emailHit?.key].filter(Boolean));

  const custom_fields: Record<string, string> = {};
  const source_metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (consumed.has(key) || CHAVES_DE_PLATAFORMA.has(key)) continue;
    if (ehChaveReservada(key)) continue; // tags/cpf têm destino próprio, nunca campo personalizado
    const str =
      typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    if (str === null) continue; // objetos/arrays aninhados: descartados no v1
    const chave = key.toLowerCase();
    // As chaves de CAMPANHA — `utm_*` e as de anúncio reservadas — descrevem como
    // a pessoa CHEGOU, não o que ela respondeu: vão para `source_metadata`, onde
    // viram a atribuição do contato, e não aparecem no card como campo
    // preenchido. `CHAVES_DE_ANUNCIO` é a lista da issue #2317.
    if (chave.startsWith("utm_") || CHAVES_DE_ANUNCIO.has(chave)) source_metadata[chave] = str;
    else custom_fields[key] = str;
  }

  return {
    name: nameHit?.value ?? null,
    phone: normalizePhoneBR(phoneHit?.value),
    email: emailHit?.value ?? null,
    custom_fields,
    source_metadata,
  };
}

/**
 * `fb.1.<instante em ms>.<clique>` — o `fbc` que o pixel da Meta escreve no
 * navegador quando o anúncio levou a uma página.
 *
 * Existe porque um formulário pode mandar SÓ o `fbclid` (página sem pixel, ou
 * pixel que não subiu): sem remontar o `fbc`, esse lead não teria identidade de
 * navegador nenhuma para a venda ser casada. O instante é o da CAPTURA aqui
 * (o envio do formulário), não o do clique original — o `fbclid` não carrega a
 * hora, e inventar uma data antiga não melhoraria a atribuição. O valor cru do
 * `fbclid` segue em `bruto`, que é a prova.
 */
export function fbcAPartirDoFbclid(fbclid: string, capturadoEmMs: number): string {
  return `fb.1.${capturadoEmMs}.${fbclid}`;
}

/** String não-vazia de um valor de payload (string, número) ou null. */
function chaveDeAnuncio(valor: unknown): string | null {
  if (typeof valor === "string") return valor.trim() || null;
  if (typeof valor === "number") return String(valor);
  return null;
}

/**
 * A atribuição de anúncio do webhook de entrada (issue #2317) — a MESMA gravação
 * do clique-pro-WhatsApp, a partir de outro transporte: o formulário.
 *
 * ─── UM extrator, TRÊS mapeadores (issue #3149) ─────────────────────────────
 *
 * A função recebe um registro CHATO de chave→valor, e é só isso que ela exige:
 * pode ser o payload CRU do envio genérico (chaves de topo, como um formulário
 * plano ou o Zapier manda) ou os `source_metadata` que um mapeador dedicado
 * acabou de montar — do Elementor (campos em colchetes), do RD Station
 * (envelope `leads[]`) ou do Respondi (respostas por rótulo de pergunta). Os
 * três entregam o clique no MESMO lugar (`source_metadata`), e é este o único
 * ponto que decide plataforma e identidade. Um segundo extrator, escrito dentro
 * de um mapeador, é justamente o que não se faz aqui: divergiria da regra de
 * `fbclid`/`fbc`/`gclid` na primeira mudança.
 *
 * O payload traz o CLIQUE (`fbclid`/`fbc` da Meta, `gclid` do Google) e, quando
 * o formulário é montado para isso, os ids da peça (`ad_id`, `adset_id`,
 * `campaign_id`). Devolve o formato AGNÓSTICO que `estamparAtribuicaoDoContato`
 * grava — a guarda de primeiro toque fica no banco, e NÃO há uma segunda cópia
 * dela aqui.
 *
 * A plataforma é decidida pelo clique presente: `fbclid`/`fbc` → Meta, `gclid` →
 * Google. Um payload com os dois é ambíguo — uma landing page que recebe as duas
 * redes — e a precedência é a do título da issue: Meta antes de Google.
 * Declarada, e não deixada à ordem das chaves no objeto.
 *
 * Sem identificador de CLIQUE não há atribuição: `ad_id` sozinho não diz de qual
 * rede o clique veio, e escolher uma seria inventar a conta que recebe a
 * conversão. As chaves seguem em `source_metadata`/`ad_raw` de qualquer forma —
 * é a prova de onde o dado saiu, não um dado descartado.
 *
 * Não há `ctwa_clid` aqui: este caminho é de FORMULÁRIO, não de clique-pro-WhatsApp.
 */
export function extrairAtribuicaoDoInbound(
  origens: Record<string, unknown>,
): AtribuicaoDeAnuncio | null {
  const chaves: Record<string, string> = {};
  for (const [key, value] of Object.entries(origens)) {
    const k = key.trim().toLowerCase();
    if (!CHAVES_DE_ANUNCIO.has(k)) continue;
    const v = chaveDeAnuncio(value);
    if (v !== null) chaves[k] = v;
  }

  const fbclid = chaves.fbclid ?? null;
  const fbc = chaves.fbc ?? null;
  const gclid = chaves.gclid ?? null;
  const plataforma: PlataformaDeAnuncio | null =
    fbclid || fbc ? "meta_ads" : gclid ? "google_ads" : null;
  if (!plataforma) return null;

  const sourceId = plataforma === "meta_ads" ? (fbclid ?? fbc) : gclid;
  if (!sourceId) return null;

  return {
    plataforma,
    sourceId,
    adId: chaves.ad_id ?? null,
    titulo: null,
    corpo: null,
    sourceUrl: null,
    // ─── O clique de FORMULÁRIO não é `ctwa_clid` (#2317) ────────────────────
    //
    // Na Meta, a identidade de quem chegou por PÁGINA é o par `fbc`/`fbp` (o
    // cookie que o pixel escreveu), não o `ctwa_clid` do anúncio
    // clique-pro-WhatsApp. Quando o formulário manda só o `fbclid`, o `fbc` é
    // remontado: sem ele a venda de formulário não tem NENHUMA identidade de
    // navegador para a plataforma casar, e mandar o `fbclid` cru no lugar do
    // `ctwa_clid` é o defeito que este campo existe para não repetir.
    ...(plataforma === "meta_ads"
      ? {
          identidadeDoNavegador: {
            fbc: fbc ?? (fbclid ? fbcAPartirDoFbclid(fbclid, Date.now()) : null),
            fbp: chaves.fbp ?? null,
          },
        }
      : {}),
    bruto: chaves,
  };
}

/** HMAC SHA-256 hex do raw body. Header: X-HiperCRM-Signature (X-Deskcomm-Signature ainda aceito na entrada). */
export function verifyInboundSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  return hmacConfere(createHmac("sha256", secret).update(rawBody).digest("hex"), header);
}

function hmacConfere(esperado: string, recebido: string): boolean {
  const a = Buffer.from(esperado, "utf8");
  const b = Buffer.from(recebido, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Quanto o carimbo do envio pode destoar do relógio do servidor, para mais ou para menos (D-215). */
export const JANELA_DO_CARIMBO_SEGUNDOS = 300;

export type MotivoDaRecusaDeAssinatura =
  | "sem_assinatura"
  | "assinatura_diferente"
  | "carimbo_ausente"
  | "carimbo_invalido"
  | "carimbo_fora_da_janela";

export type ResultadoDaAssinatura =
  | { valida: true; comCarimbo: boolean }
  | { valida: false; motivo: MotivoDaRecusaDeAssinatura };

/**
 * Confere a assinatura de um envio à captação, com a proteção contra reenvio (D-215).
 *
 * Dois formatos:
 *   - COM carimbo (`X-HiperCRM-Timestamp`, segundos Unix): a assinatura é o HMAC-SHA256 hex de
 *     `v1:${carimbo}.${corpoCru}` e o carimbo precisa estar a até 300 s do relógio do servidor. Um envio
 *     capturado deixa de valer depois da janela. O prefixo `v1:` versiona o formato e impede que um corpo
 *     que comece com dígitos e ponto (`123.`) faça a assinatura de `corpo` colidir com a de `carimbo.corpo`.
 *   - SEM carimbo: o formato antigo, HMAC do corpo cru. Só vale enquanto a fonte NÃO exige carimbo.
 *     A rota liga `exige_carimbo` na primeira requisição válida com carimbo, e dali em diante o formato
 *     antigo é recusado: quem já assinava sem carimbo não quebra no dia da atualização, e quem migrou
 *     fica protegido.
 *
 * Pura: o relógio entra por parâmetro.
 */
export function conferirAssinaturaDaCaptacao(entrada: {
  rawBody: string;
  assinatura: string | null;
  carimbo: string | null;
  segredo: string;
  exigeCarimbo: boolean;
  agoraMs?: number;
}): ResultadoDaAssinatura {
  const { rawBody, assinatura, carimbo, segredo, exigeCarimbo } = entrada;
  if (!assinatura) return { valida: false, motivo: "sem_assinatura" };

  if (carimbo === null || carimbo === "") {
    if (exigeCarimbo) return { valida: false, motivo: "carimbo_ausente" };
    return verifyInboundSignature(rawBody, assinatura, segredo)
      ? { valida: true, comCarimbo: false }
      : { valida: false, motivo: "assinatura_diferente" };
  }

  // Segundos Unix inteiros. Milissegundos (13 dígitos) caem aqui como inválido de propósito: aceitá-los
  // como segundos os jogaria no futuro, e a recusa pelo motivo certo ajuda quem integra.
  if (!/^\d{1,11}$/.test(carimbo)) return { valida: false, motivo: "carimbo_invalido" };
  const agora = entrada.agoraMs ?? Date.now();
  if (Math.abs(agora / 1000 - Number(carimbo)) > JANELA_DO_CARIMBO_SEGUNDOS) {
    return { valida: false, motivo: "carimbo_fora_da_janela" };
  }
  const esperado = createHmac("sha256", segredo).update(`v1:${carimbo}.${rawBody}`).digest("hex");
  return hmacConfere(esperado, assinatura)
    ? { valida: true, comCarimbo: true }
    : { valida: false, motivo: "assinatura_diferente" };
}
