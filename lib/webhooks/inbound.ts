/**
 * Parsing do inbound de captação: field_map → lead normalizado + HMAC.
 * Sem I/O — puro, testável. A rota (webhooks/in/[token]) faz o resto.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { cnpjValido, cpfValido, somenteDigitos } from "@/lib/documentos/cpf-cnpj";

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
    if (consumed.has(key)) continue;
    if (ehChaveReservada(key)) continue; // tags/cpf têm destino próprio, nunca campo personalizado
    const str =
      typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    if (str === null) continue; // objetos/arrays aninhados: descartados no v1
    if (key.toLowerCase().startsWith("utm_")) source_metadata[key.toLowerCase()] = str;
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
 *     `${carimbo}.${corpoCru}` e o carimbo precisa estar a até 300 s do relógio do servidor. Um envio
 *     capturado deixa de valer depois da janela.
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
  const esperado = createHmac("sha256", segredo).update(`${carimbo}.${rawBody}`).digest("hex");
  return hmacConfere(esperado, assinatura)
    ? { valida: true, comCarimbo: true }
    : { valida: false, motivo: "assinatura_diferente" };
}
