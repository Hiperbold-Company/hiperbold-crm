/**
 * A ESCOLHA PENDENTE das contas da Meta (D-242): o cookie selado que o callback
 * do OAuth grava quando a descoberta traz duas ou mais contas.
 *
 * Por que existe: o callback conectava TODAS as contas que o token alcançava.
 * Um operador de agência que marca "todas as páginas" na Meta tem acesso às
 * páginas de todos os clientes, e num caso real 66 páginas de outros clientes
 * viraram conexões na empresa errada. Agora, com 2+ contas, nada é conectado
 * na volta: a tela pergunta quais são desta empresa.
 *
 * O que o cookie guarda: só o TOKEN-FONTE (o já trocado pelo `code`, que é de
 * uso único) e o modo da descoberta, mais o que `conectarConta` precisa e o
 * callback calculou. Os tokens de página não cabem (66 deles passam dos 4 KB
 * de um cookie): a listagem e a confirmação REDESCOBREM com o token-fonte
 * (`descoberta.ts`).
 *
 * A carga é CIFRADA (AES-256-GCM), no molde de `estado.ts`, com chave PRÓPRIA:
 * HKDF do `INTERNAL_SECRET` com o rótulo `meta_social_selecao`, nunca o do
 * `state`. Um `state` do OAuth não abre a escolha e a escolha não vale como
 * `state`. A plataforma entra como dado associado: a escolha do Instagram não
 * abre no caminho do Messenger. O nonce é novo, e a confirmação o queima em
 * `calendar_oauth_nonces` (23505 = já usada).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { ehPlataformaMetaSocial, type PlataformaMetaSocial } from "./constantes";

/** O ramo da descoberta que achou as contas (ver `descoberta.ts`). */
export const MODOS_DA_DESCOBERTA = ["instagram_sistema", "instagram_pagina", "messenger"] as const;
export type ModoDaDescoberta = (typeof MODOS_DA_DESCOBERTA)[number];

export function ehModoDaDescoberta(v: unknown): v is ModoDaDescoberta {
  return typeof v === "string" && (MODOS_DA_DESCOBERTA as readonly string[]).includes(v);
}

/** A plataforma que cada modo serve: um modo do Instagram nunca conecta Messenger. */
export function plataformaDoModo(modo: ModoDaDescoberta): PlataformaMetaSocial {
  return modo === "messenger" ? "messenger" : "instagram";
}

export const NOME_DA_SELECAO_META_SOCIAL = "crm_meta_social_selecao";
/** O cookie só viaja para o endpoint da escolha. */
export const CAMINHO_DA_SELECAO_META_SOCIAL = "/api/v1/channels/meta-social/selecao";
export const VALIDADE_DA_SELECAO_MS = 10 * 60 * 1000;
export const VALIDADE_DA_SELECAO_S = 10 * 60;

const DOMINIO = "meta_social_selecao";
const VERSAO = "v1";
const TAMANHO_DO_IV = 12;
const TAMANHO_DA_TAG = 16;
/**
 * Teto do valor selado. Um cookie inteiro (nome, valor e atributos) cabe em
 * 4096 bytes; acima disso o navegador o descarta calado e a escolha some.
 * Quem sela recusa antes de gravar; quem abre recusa o que passa disso.
 */
export const TETO_DA_SELECAO = 3600;

export interface SelecaoMetaSocial {
  plataforma: PlataformaMetaSocial;
  organizationId: string;
  userId: string;
  authSessionId?: string;
  nonce: string;
  expiraEmMs: number;
  modo: ModoDaDescoberta;
  /** O token que a descoberta usa (SUAT ou token de usuário longo). NUNCA sai para a tela. */
  tokenFonte: string;
  /** Validade do token gravada na conexão (ISO), ou `null` quando não vence. */
  expiraEm: string | null;
  autorizadorId: string | null;
  empresaId: string | null;
}

function segredoValido(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < 16) throw new Error("INTERNAL_SECRET ausente ou curto demais para selar a escolha");
  return s;
}

function chaveDaSelecao(segredo: string): Buffer {
  return Buffer.from(hkdfSync("sha256", segredo, `${DOMINIO}.cookie`, VERSAO, 32));
}

const dadoAssociado = (plataforma: PlataformaMetaSocial) => Buffer.from(`${DOMINIO}.${VERSAO}.${plataforma}`, "utf8");

export function selarSelecaoMetaSocial(
  dados: Omit<SelecaoMetaSocial, "nonce" | "expiraEmMs">,
  opcoes: { segredo: string; agora: Date; nonce?: string },
): string {
  const segredo = segredoValido(opcoes.segredo);
  if (!dados.organizationId || !dados.userId) throw new Error("escolha sem organização ou usuário");
  if (!dados.tokenFonte) throw new Error("escolha sem token");
  if (plataformaDoModo(dados.modo) !== dados.plataforma) throw new Error("modo de outra plataforma");
  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const carga = JSON.stringify({
    d: DOMINIO,
    p: dados.plataforma,
    o: dados.organizationId,
    u: dados.userId,
    n: nonce,
    e: opcoes.agora.getTime() + VALIDADE_DA_SELECAO_MS,
    m: dados.modo,
    t: dados.tokenFonte,
    x: dados.expiraEm,
    a: dados.autorizadorId,
    b: dados.empresaId,
    ...(dados.authSessionId ? { s: dados.authSessionId } : {}),
  });
  const iv = randomBytes(TAMANHO_DO_IV);
  const cifra = createCipheriv("aes-256-gcm", chaveDaSelecao(segredo), iv);
  cifra.setAAD(dadoAssociado(dados.plataforma));
  const corpo = Buffer.concat([cifra.update(carga, "utf8"), cifra.final()]);
  const valor = Buffer.concat([iv, corpo, cifra.getAuthTag()]).toString("base64url");
  if (valor.length > TETO_DA_SELECAO) throw new Error("escolha grande demais para caber no cookie");
  return valor;
}

const texto = (v: unknown): string => (typeof v === "string" ? v : "");
const textoOuNulo = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Abre a escolha. `null` = ausente, adulterada, de outra plataforma, de outra chave ou vencida. */
export function abrirSelecaoMetaSocial(
  valor: string | null | undefined,
  opcoes: { segredo: string; agora: Date; plataforma: PlataformaMetaSocial },
): SelecaoMetaSocial | null {
  if (!valor || valor.length > TETO_DA_SELECAO || !/^[A-Za-z0-9_-]+$/.test(valor)) return null;
  const segredo = segredoValido(opcoes.segredo);
  const bruto = Buffer.from(valor, "base64url");
  if (bruto.length <= TAMANHO_DO_IV + TAMANHO_DA_TAG) return null;
  const iv = bruto.subarray(0, TAMANHO_DO_IV);
  const tag = bruto.subarray(bruto.length - TAMANHO_DA_TAG);
  const corpo = bruto.subarray(TAMANHO_DO_IV, bruto.length - TAMANHO_DA_TAG);

  let carga: Record<string, unknown>;
  try {
    const decifra = createDecipheriv("aes-256-gcm", chaveDaSelecao(segredo), iv);
    decifra.setAAD(dadoAssociado(opcoes.plataforma));
    decifra.setAuthTag(tag);
    const claro = Buffer.concat([decifra.update(corpo), decifra.final()]).toString("utf8");
    const lido: unknown = JSON.parse(claro);
    if (!lido || typeof lido !== "object") return null;
    carga = lido as Record<string, unknown>;
  } catch {
    // Tag que não confere (adulterada, outra chave, outra plataforma) ou lixo.
    return null;
  }

  const plataforma = carga.p;
  if (carga.d !== DOMINIO || !ehPlataformaMetaSocial(plataforma) || plataforma !== opcoes.plataforma) return null;
  const modo = carga.m;
  if (!ehModoDaDescoberta(modo) || plataformaDoModo(modo) !== plataforma) return null;
  const organizationId = texto(carga.o);
  const userId = texto(carga.u);
  const nonce = texto(carga.n);
  const tokenFonte = texto(carga.t);
  const authSessionId = texto(carga.s);
  const expiraEmMs = typeof carga.e === "number" ? carga.e : Number.NaN;
  if (!organizationId || !userId || !nonce || !tokenFonte || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;
  return {
    plataforma,
    organizationId,
    userId,
    nonce,
    expiraEmMs,
    modo,
    tokenFonte,
    expiraEm: textoOuNulo(carga.x),
    autorizadorId: textoOuNulo(carga.a),
    empresaId: textoOuNulo(carga.b),
    ...(authSessionId ? { authSessionId } : {}),
  };
}
