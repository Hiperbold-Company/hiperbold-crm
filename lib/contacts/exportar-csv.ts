/**
 * O CSV de contatos — PURO (sem banco): recebe as linhas já lidas e devolve o texto.
 *
 * Feito para abrir no Excel em português do Brasil sem ajuste:
 *  - UTF-8 COM BOM (sem ele o Excel lê como ANSI e estraga os acentos);
 *  - separador VÍRGULA, fim de linha CRLF, aspas duplas quando preciso (RFC 4180);
 *  - telefone formatado ("+55 35 99999-9999"): com espaço o Excel o trata como texto —
 *    sem isso um número de 13 dígitos vira "5,5E+12";
 *  - datas "dd/mm/aaaa hh:mm" no FUSO DA ORGANIZAÇÃO.
 *
 * NUNCA sai CPF: as colunas de CPF (hash e cifrado) nem são lidas pela rota, e campo
 * personalizado com chave de documento (cpf, cnpj, rg, documento, passaporte —
 * `lib/contacts/campos-sensiveis.ts`) é descartado aqui por garantia.
 *
 * Planilha interpreta como fórmula a célula que começa com `=`, `@`, tab ou CR (e `+`/`-`
 * seguidos de algo que não é número): o valor leva um `'` na frente. Telefone e número
 * (`+55 35 …`, `-12,5`) não levam — não são fórmula e a aspa estragaria o dado.
 */
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDaOrigem } from "@/lib/contacts/origens";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

export const BOM = "﻿";

export interface ContatoParaCsv {
  display_name?: string | null;
  name?: string | null;
  email: string | null;
  phone_number: string | null;
  tags: string[] | null;
  source: string | null;
  created_at: string | null;
  last_activity_at: string | null;
  custom_fields: Record<string, unknown> | null;
  /** Negócios do contato: só funil e etapa interessam. */
  leads?: Array<{ pipeline_id: string; stage_id: string }> | null;
}

export interface ReferenciasDoCsv {
  /** Fuso IANA da organização (datas). Ausente = UTC. */
  timezone?: string | null;
  funis: Map<string, string>;
  etapas: Map<string, string>;
  /** Rótulo amigável por chave de campo personalizado (cabeçalho da coluna). */
  rotulosDeCampo?: Map<string, string>;
}

/** Máximo de colunas de campo personalizado: uma base bagunçada não pode gerar 500 colunas. */
const TETO_DE_COLUNAS_DE_CAMPO = 40;
const NUMERO_OU_TELEFONE = /^[+-]?[\d\s().,-]+$/;

export function celulaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  let s = typeof valor === "string" ? valor : String(valor);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !NUMERO_OU_TELEFONE.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dataHora(iso: string | null, tz: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Montado à mão (dd/mm/aaaa hh:mm) sobre as PARTES numéricas: o arquivo é para o Excel
  // em português do Brasil, e a ordem dos campos não deve depender do idioma da interface.
  const opcoes: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  let partes: Intl.DateTimeFormatPart[];
  try {
    partes = new Intl.DateTimeFormat("en-US", { ...opcoes, timeZone: tz || "UTC" }).formatToParts(d);
  } catch {
    partes = new Intl.DateTimeFormat("en-US", { ...opcoes, timeZone: "UTC" }).formatToParts(d);
  }
  const v = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${v("day")}/${v("month")}/${v("year")} ${v("hour")}:${v("minute")}`;
}

/** "+5535999999999" → "+55 35 99999-9999"; o que não for celular/fixo BR volta como está. */
export function telefoneParaPlanilha(raw: string | null | undefined): string {
  const canonico = phoneForDisplay(raw);
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(canonico);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : canonico;
}

function textoDoValor(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  if (Array.isArray(valor)) return valor.map(textoDoValor).filter(Boolean).join("; ");
  return JSON.stringify(valor);
}

export function montarCsvDeContatos(contatos: ContatoParaCsv[], ref: ReferenciasDoCsv): string {
  const frequencia = new Map<string, number>();
  for (const c of contatos) {
    for (const [chave, valor] of Object.entries(c.custom_fields ?? {})) {
      if (chaveSensivelDeCampo(chave) || textoDoValor(valor) === "") continue;
      frequencia.set(chave, (frequencia.get(chave) ?? 0) + 1);
    }
  }
  const chavesDeCampo = [...frequencia.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TETO_DE_COLUNAS_DE_CAMPO)
    .map(([chave]) => chave);

  const cabecalho = [
    "Nome",
    "E-mail",
    "Telefone",
    "Tags",
    "Origem",
    "Entrou no CRM",
    "Última atividade",
    "Funis e etapas",
    ...chavesDeCampo.map((chave) => ref.rotulosDeCampo?.get(chave) ?? chave),
  ];

  const linhas = contatos.map((c) => {
    const funisEEtapas = [
      ...new Set(
        (c.leads ?? []).map((l) => {
          const funil = ref.funis.get(l.pipeline_id) ?? "";
          const etapa = ref.etapas.get(l.stage_id) ?? "";
          return [funil, etapa].filter(Boolean).join(" > ");
        }),
      ),
    ].filter(Boolean);
    return [
      nomeDoContato(c) ?? "",
      c.email ?? "",
      telefoneParaPlanilha(c.phone_number),
      (c.tags ?? []).join("; "),
      rotuloDaOrigem(c.source),
      dataHora(c.created_at, ref.timezone),
      dataHora(c.last_activity_at, ref.timezone),
      funisEEtapas.join("; "),
      ...chavesDeCampo.map((chave) => textoDoValor((c.custom_fields ?? {})[chave])),
    ]
      .map(celulaCsv)
      .join(",");
  });

  return BOM + [cabecalho.map(celulaCsv).join(","), ...linhas].join("\r\n") + "\r\n";
}
