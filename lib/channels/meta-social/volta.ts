/**
 * A volta do OAuth para a tela de conexões. Mesmo desenho do callback da
 * agenda: um documento que navega para o destino com `location.replace`, para
 * a navegação seguinte partir do nosso próprio site e o cookie de sessão
 * (`SameSite=Strict`) voltar a viajar. Um 302 direto vindo do Instagram
 * chegaria à tela SEM sessão e mandaria a pessoa ao login.
 */
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { CAMINHO_DA_TELA_DE_CONEXOES, CAMINHO_DO_CALLBACK_META_SOCIAL } from "./constantes";
import { NOME_DO_VINCULO_META_SOCIAL } from "./estado";
import type { PlataformaMetaSocial } from "./constantes";
import { CAMINHO_DA_SELECAO_META_SOCIAL, NOME_DA_SELECAO_META_SOCIAL, VALIDADE_DA_SELECAO_S } from "./selecao";

export function destinoDaVolta(parametros: Record<string, string | number>): string {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const u = new URL(CAMINHO_DA_TELA_DE_CONEXOES, base);
  u.searchParams.set("aba", "sociais");
  for (const [k, v] of Object.entries(parametros)) u.searchParams.set(k, String(v));
  return u.toString();
}

export function voltarParaConexoes(parametros: Record<string, string | number>): NextResponse {
  const destino = destinoDaVolta(parametros);
  const seguro = destino
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const resposta = new NextResponse(
    `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
      `<meta name="robots" content="noindex">` +
      `<noscript><meta http-equiv="refresh" content="0;url=${seguro}"></noscript>` +
      `<title>Voltando…</title></head><body>` +
      `<p>Voltando para as conexões…</p>` +
      `<script>location.replace(${JSON.stringify(destino)})</script>` +
      `<noscript><p><a href="${seguro}">Continuar</a></p></noscript>` +
      `</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
  resposta.cookies.set(NOME_DO_VINCULO_META_SOCIAL, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_META_SOCIAL,
    maxAge: 0,
  });
  return resposta;
}

/**
 * Volta com DUAS ou mais contas descobertas (D-242): nada foi conectado; a tela
 * abre a escolha (`meta_social=escolher`) e o cookie selado leva o que a
 * listagem e a confirmação precisam. `Lax`: a navegação vem da Meta (outro
 * site) e o cookie tem de ser gravado nela; o caminho restrito faz ele viajar
 * só para o endpoint da escolha.
 */
export function voltarParaEscolher(plataforma: PlataformaMetaSocial, selecaoSelada: string): NextResponse {
  const resposta = voltarParaConexoes({ meta_social: "escolher", plataforma });
  resposta.cookies.set(NOME_DA_SELECAO_META_SOCIAL, selecaoSelada, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DA_SELECAO_META_SOCIAL,
    maxAge: VALIDADE_DA_SELECAO_S,
  });
  return resposta;
}

/** Apaga a escolha pendente (confirmada, cancelada, vencida ou já usada). */
export function limparSelecao<T extends NextResponse>(resposta: T): T {
  resposta.cookies.set(NOME_DA_SELECAO_META_SOCIAL, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DA_SELECAO_META_SOCIAL,
    maxAge: 0,
  });
  return resposta;
}

/** O `redirect_uri` registrado no app da Meta: origem pública + caminho fixo. */
export function redirectUriDe(caminho: string): string {
  return new URL(caminho, env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").toString();
}
