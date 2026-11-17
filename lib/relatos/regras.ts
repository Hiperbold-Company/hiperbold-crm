/**
 * Relatos de problema (migration 1018): os limites e o contrato do corpo, num lugar só.
 *
 * Puro, sem dependência de Node: o botão do navegador importa os limites daqui, e a rota
 * `POST /api/v1/bug-reports` valida com os mesmos números. As CHECKs da tabela repetem
 * esses limites no banco, porque quem tem sessão pode inserir pela REST sem passar pela rota.
 */
import { z } from "zod";

import { apagarDadosPessoais } from "@/lib/erros/erro-do-navegador";

export const BUCKET_DOS_RELATOS = "bug-reports";

export const DESCRICAO_MIN = 10;
export const DESCRICAO_MAX = 2000;
/** Teto do print. O mesmo `file_size_limit` do bucket na migration 1018. */
export const PRINT_MAX_BYTES = 3 * 1024 * 1024;
export const MAX_ERROS_DO_CONSOLE = 10;
export const MAX_ERRO_DO_CONSOLE = 500;
export const MAX_URL = 2000;
export const MAX_USER_AGENT = 500;

/** Relatos por usuário por hora. */
export const RELATOS_POR_HORA = 10;
/** Linha e print saem depois disto (cron `data-retention`). */
export const RETENCAO_DOS_RELATOS_DIAS = 90;

export const STATUS_DO_RELATO = ["novo", "em_andamento", "resolvido", "descartado"] as const;
export type StatusDoRelato = (typeof STATUS_DO_RELATO)[number];

/**
 * O `page_url` é caminho RELATIVO da própria instalação: começa com `/`, nunca com `//`, e não
 * tem barra invertida (o navegador lê `/\\x` como `//x`). Sem esquema, sem host. A mesma regra
 * está na CHECK `bug_reports_page_url_check` e decide se o painel monta link com o valor.
 */
export function caminhoRelativoSeguro(valor: string): boolean {
  return valor.length <= MAX_URL && valor.startsWith("/") && !valor.startsWith("//") && !valor.includes("\\");
}

export const DescricaoSchema = z.string().trim().min(DESCRICAO_MIN).max(DESCRICAO_MAX);

/**
 * O contexto técnico que o botão manda junto. Campos a mais são descartados; os erros do
 * console passam pela mesma limpeza de dado pessoal dos erros do navegador.
 */
export const ContextoDoRelatoSchema = z.object({
  url: z.string().trim().max(MAX_URL).refine(caminhoRelativoSeguro).optional(),
  user_agent: z.string().max(MAX_USER_AGENT).optional(),
  viewport: z
    .object({
      largura: z.number().int().min(0).max(100_000),
      altura: z.number().int().min(0).max(100_000),
    })
    .optional(),
  idioma: z.string().max(20).optional(),
  erros: z
    .array(z.string().max(MAX_ERRO_DO_CONSOLE).transform(apagarDadosPessoais))
    .max(MAX_ERROS_DO_CONSOLE)
    .optional(),
});
export type ContextoDoRelato = z.infer<typeof ContextoDoRelatoSchema>;

export type TipoDoPrint = "image/webp" | "image/png";

/**
 * O formato pela ASSINATURA dos bytes, nunca pelo `content-type` que o navegador declarou.
 * PNG: `89 50 4E 47 0D 0A 1A 0A`. WebP: `RIFF` + 4 bytes de tamanho + `WEBP`.
 */
export function farejarPrint(bytes: Uint8Array): TipoDoPrint | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  const ascii = (inicio: number, texto: string) =>
    [...texto].every((c, i) => bytes[inicio + i] === c.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** O único caminho que a CHECK `bug_reports_screenshot_path_check` aceita. */
export function caminhoDoPrint(organizationId: string, relatoId: string, tipo: TipoDoPrint): string {
  return `${organizationId}/${relatoId}.${tipo === "image/png" ? "png" : "webp"}`;
}
