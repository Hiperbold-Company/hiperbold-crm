/**
 * Erro do navegador registrado no log do SERVIDOR (`POST /api/v1/client-errors`).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Em 11/11/2026 o GoTrue respondeu 429 em rajada e as telas caíram no
 * "Algo deu errado" — e nada disso chegou a lugar nenhum, porque a instalação
 * roda com `SENTRY_DSN=off`. O `SegmentError` e o `global-error` capturavam no
 * Sentry desligado e o erro morria no navegador. Este módulo é o contrato do
 * relato mínimo que vai para o log do servidor, que existe em toda instalação.
 *
 * ─── O que entra, e o que é apagado ─────────────────────────────────────────
 *
 * Só o necessário para achar o erro no log: nome, mensagem, digest, segmento,
 * caminho e o começo da pilha. Nada de query string, e na mensagem e na pilha
 * e-mail, telefone, qualquer sequência de 6+ dígitos (CPF, CNPJ, número de
 * pedido), JWT (`eyJ…`) e chave `dsk_` são apagados ANTES de gravar (no nome e
 * na rota também; na rota, segmento opaco de 16+ caracteres vira `:token`): mensagem de erro é texto livre e às
 * vezes carrega o dado que estava na tela. A rota é pública por desenho (o
 * erro pode ser justamente "não está logado"), então o corpo é dado de
 * terceiro e passa inteiro por aqui.
 *
 * Puro, sem dependência de Node: o lado do navegador importa os limites.
 */
import { z } from "zod";

/** Teto do corpo da requisição, em bytes. */
export const TETO_DO_CORPO_BYTES = 4 * 1024;
export const MAX_NOME = 80;
export const MAX_MENSAGEM = 300;
export const MAX_LINHAS_DA_PILHA = 8;
/** Teto bruto da pilha recebida (antes do corte em 8 linhas). */
export const MAX_PILHA = 2000;
export const MAX_ROTA = 300;

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
/**
 * Telefone: um `+` opcional e um trecho de dígitos com separadores comuns
 * (espaço, ponto, hífen, parênteses) somando 8 dígitos ou mais. Vem antes da
 * regra de 6+ dígitos para `(35) 99148-5627` sumir inteiro, e não em pedaços.
 */
const TELEFONE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const DIGITOS = /\d{6,}/g;
/** JWT (`eyJ…`, inclusive só o cabeçalho) e chave da API (`dsk_…`). */
const JWT = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const CHAVE_DA_API = /dsk_[A-Za-z0-9_-]+/g;
/** Segmento de caminho com cara de token: 16+ caracteres de base64url. */
const SEGMENTO_TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Apaga e-mail, telefone, sequência de 6+ dígitos, JWT e chave `dsk_` de um
 * texto livre. Credencial primeiro: os dígitos de dentro de um token não podem
 * virar `[numero]` e deixar o resto do token à vista.
 */
export function apagarDadosPessoais(texto: string): string {
  return texto
    .replace(JWT, "[jwt]")
    .replace(CHAVE_DA_API, "[chave]")
    .replace(EMAIL, "[email]")
    .replace(TELEFONE, (trecho) =>
      (trecho.match(/\d/g)?.length ?? 0) >= 8 ? "[telefone]" : trecho,
    )
    .replace(DIGITOS, "[numero]");
}

/**
 * Só o caminho, com identificadores trocados por `:id`. Aceita caminho ou URL
 * inteira; query string e fragmento saem sempre.
 */
export function normalizarRota(bruto: string): string {
  let caminho = bruto.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(caminho)) caminho = new URL(caminho).pathname;
  } catch {
    /* segue com o texto, sem query */
  }
  caminho = caminho.split(/[?#]/)[0] ?? "";
  if (!caminho.startsWith("/")) caminho = `/${caminho}`;
  return caminho
    .split("/")
    .map((seg) => {
      const semUuid = seg.replace(UUID, ":id");
      if (/^\d+$/.test(semUuid)) return ":id";
      // Link de convite, estado assinado, token de reset: segmento longo opaco.
      if (SEGMENTO_TOKEN.test(semUuid)) return ":token";
      return apagarDadosPessoais(semUuid.replace(/\d{6,}/g, ":id"));
    })
    .join("/");
}

/** No máximo 8 linhas, sem query string nas URLs, sem dado pessoal. */
export function limparPilha(bruta: string): string {
  return bruta
    .split(/\r?\n/)
    .slice(0, MAX_LINHAS_DA_PILHA)
    .map((linha) => apagarDadosPessoais(linha.replace(/\?[^\s):]*/g, "")).trimEnd())
    .join("\n");
}

const curto = (max: number, formato: RegExp) => z.string().trim().min(1).max(max).regex(formato);

export const ErroDoNavegadorSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NOME).transform(apagarDadosPessoais),
  message: z.string().max(MAX_MENSAGEM).transform(apagarDadosPessoais),
  digest: curto(64, /^[A-Za-z0-9_-]+$/).optional(),
  segment: curto(40, /^[A-Za-z0-9_-]+$/).optional(),
  route: z.string().max(MAX_ROTA).transform(normalizarRota).optional(),
  stack: z.string().max(MAX_PILHA).transform(limparPilha).optional(),
  release: curto(64, /^[A-Za-z0-9._+-]+$/).optional(),
  ua_family: z.enum(["chrome", "edge", "firefox", "safari", "samsung", "outro"]).optional(),
});

export type ErroDoNavegador = z.infer<typeof ErroDoNavegadorSchema>;
