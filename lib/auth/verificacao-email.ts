/**
 * Verificação de e-mail do CRM (substitui a confirmação do Supabase, que fica em `mailer_autoconfirm = true`
 * em produção: a pessoa entra antes de confirmar, e o CRM só avisa numa faixa no topo).
 *
 * ─── Onde cada dado mora (doutrina DIRC, e por quê não há tabela nova) ──────
 *
 * Tudo em `auth.users.raw_app_meta_data` (`app_metadata`), que só a service role escreve. NÃO em
 * `user_metadata`: esse a própria pessoa grava por `supabase.auth.updateUser`, e um carimbo de "e-mail
 * verificado" que o dono do e-mail pode se dar sozinho não verifica nada. `email_confirmed_at` também não
 * serve: com a confirmação automática ligada o provedor o preenche na criação da conta.
 *
 *   app_metadata.email_verificado_em        carimbo ISO de quando o link foi aberto (a verdade, quando existe)
 *   app_metadata.email_verificacao          o PEDIDO em aberto: { hash, expira_em, enviado_em }
 *
 * O token não é guardado, só o SHA-256 do segredo. O token que viaja no link é `<user_id>.<segredo>`: o
 * `user_id` serve só para achar a conta (não é segredo, e o link é de uso único), e a prova é o segredo,
 * comparado em tempo constante com o hash. Aberto o link, o pedido é apagado (uso único); pedir outro link
 * troca o pedido (o anterior deixa de valer).
 *
 * ─── Quem conta como verificado (e por que as contas antigas não veem a faixa) ──────────────────
 *
 *   verificado = tem `email_verificado_em`  OU  não tem pedido em aberto
 *
 * Só quem se cadastrou DEPOIS desta mudança pelo caminho de e-mail ganha um pedido (a ação de cadastro o
 * grava junto com a conta). Logo, toda conta que já existia, quem entrou com o Google (o provedor já
 * verificou o endereço), quem entrou por convite assinado para o endereço e quem confirmou pelo link do
 * Supabase antes da virada NÃO tem pedido e conta como verificada, sem constante de data para ajustar no
 * deploy. O custo conhecido: se a gravação do pedido falhar no cadastro, a pessoa aparece como verificada
 * (falha aberta, e a faixa nunca bloqueia nada).
 *
 * Nada aqui lança por falha de rede: o resultado é um objeto com o motivo.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

/** Validade do link, em dias. */
export const VALIDADE_DO_LINK_EM_DIAS = 7;
const VALIDADE_EM_MS = VALIDADE_DO_LINK_EM_DIAS * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 bytes em base64url = 43 caracteres. */
const SEGREDO = /^[A-Za-z0-9_-]{43}$/;

export interface PedidoDeVerificacao {
  /** SHA-256 (hex) do segredo. */
  hash: string;
  expira_em: string;
  enviado_em: string;
}

type AppMetadata = Record<string, unknown>;

export function hashDoSegredo(segredo: string): string {
  return createHash("sha256").update(segredo).digest("hex");
}

/** Gera o par token (vai no link) e hash (vai para o `app_metadata`). */
export function gerarToken(userId: string): { token: string; hash: string } {
  const segredo = randomBytes(32).toString("base64url");
  return { token: `${userId}.${segredo}`, hash: hashDoSegredo(segredo) };
}

/** Separa `<user_id>.<segredo>`. Forma errada devolve `null` (nunca chega ao banco). */
export function lerToken(token: unknown): { userId: string; segredo: string } | null {
  if (typeof token !== "string") return null;
  const ponto = token.indexOf(".");
  if (ponto < 0) return null;
  const userId = token.slice(0, ponto);
  const segredo = token.slice(ponto + 1);
  if (!UUID.test(userId) || !SEGREDO.test(segredo)) return null;
  return { userId: userId.toLowerCase(), segredo };
}

export function pedidoEmAberto(appMetadata: unknown): PedidoDeVerificacao | null {
  const bruto = (appMetadata as AppMetadata | null | undefined)?.email_verificacao;
  if (!bruto || typeof bruto !== "object") return null;
  const p = bruto as Partial<PedidoDeVerificacao>;
  if (typeof p.hash !== "string" || typeof p.expira_em !== "string" || typeof p.enviado_em !== "string") {
    return null;
  }
  return { hash: p.hash, expira_em: p.expira_em, enviado_em: p.enviado_em };
}

/** A regra de "verificado" (ver o cabeçalho). Pura: vale no servidor e nos testes. */
export function emailVerificado(appMetadata: unknown): boolean {
  const meta = (appMetadata as AppMetadata | null | undefined) ?? {};
  if (typeof meta.email_verificado_em === "string" && meta.email_verificado_em !== "") return true;
  return pedidoEmAberto(meta) === null;
}

type AdminMinimo = Pick<SupabaseClient, "auth">;

/**
 * Lê o `app_metadata` atual e grava o resultado de `alterar` por cima. Lê-e-escreve o objeto inteiro
 * (`provider` e `providers` voltam).
 *
 * ⚠️ O GoTrue MESCLA o `app_metadata` enviado com o que já existe: omitir uma chave NÃO a remove — só o
 * `null` explícito remove. Por isso a chave que `alterar` tira (valor `null`, ou presente antes e ausente
 * depois) é enviada como `null`, nunca apagada do objeto: apagada, o `email_verificacao` continuava gravado
 * depois do uso e o link deixava de ser de uso único. `alterar` devolvendo `null` não grava nada.
 */
async function alterarAppMetadata(
  admin: AdminMinimo,
  userId: string,
  alterar: (atual: AppMetadata) => AppMetadata | null,
): Promise<{ ok: true; email: string | null; antes: AppMetadata } | { ok: false; motivo: "usuario_nao_encontrado" | "gravacao_falhou" }> {
  const lido = await admin.auth.admin.getUserById(userId);
  const usuario = lido.data?.user;
  if (lido.error || !usuario) return { ok: false, motivo: "usuario_nao_encontrado" };
  const antes = { ...((usuario.app_metadata as AppMetadata | undefined) ?? {}) };
  const depois = alterar({ ...antes });
  // `null` = nada a gravar (a recusa não escreve no provedor: pedido anônimo não vira escrita).
  if (depois === null) return { ok: true, email: usuario.email ?? null, antes };
  const enviado: AppMetadata = { ...depois };
  for (const k of Object.keys(antes)) if (!(k in enviado)) enviado[k] = null;
  const gravado = await admin.auth.admin.updateUserById(userId, { app_metadata: enviado });
  if (gravado.error) return { ok: false, motivo: "gravacao_falhou" };
  return { ok: true, email: usuario.email ?? null, antes };
}

/** Grava chaves soltas no `app_metadata` (ex.: o aceite dos Termos no cadastro). */
export async function gravarNoAppMetadata(
  admin: AdminMinimo,
  userId: string,
  chaves: AppMetadata,
): Promise<boolean> {
  const r = await alterarAppMetadata(admin, userId, (atual) => ({ ...atual, ...chaves }));
  return r.ok;
}

export type EmissaoDoPedido =
  | { ok: true; token: string; email: string | null; expiraEm: string; hash: string }
  | { ok: false; motivo: "usuario_nao_encontrado" | "gravacao_falhou" | "ja_verificado" | "muito_cedo" };

/**
 * Abre (ou troca) o pedido de verificação da conta e devolve o token do link.
 *
 * `junto`: outras chaves gravadas na mesma chamada (o cadastro grava o aceite dos Termos aqui, economizando
 * uma ida ao provedor). `intervaloMinimoMs`: recusa um pedido novo antes disso desde o último envio (o
 * "1 por minuto" do reenvio, durável porque mora no próprio pedido).
 */
export async function emitirPedido(p: {
  admin: AdminMinimo;
  userId: string;
  agora?: Date;
  junto?: AppMetadata;
  intervaloMinimoMs?: number;
  /**
   * Só reabre um pedido que JÁ existe (o reenvio). Sem isto, conta antiga, de Google ou de convite, que não
   * tem pedido e conta como verificada, ganharia um e passaria a ver a faixa por ter chamado o "Reenviar".
   */
  somenteSePendente?: boolean;
  /**
   * Confere tudo (carimbo, pedido existente, intervalo mínimo) e gera o token, MAS NÃO GRAVA o pedido: quem
   * chama grava com `gravarPedido` só depois de o e-mail sair. É o reenvio: gravar antes trocava o hash do
   * link que já está na caixa da pessoa por um de e-mail que talvez nunca saia, e um envio que falha
   * deixava a pessoa sem link nenhum válido.
   */
  semGravar?: boolean;
}): Promise<EmissaoDoPedido> {
  const agora = p.agora ?? new Date();
  const { token, hash } = gerarToken(p.userId);
  const expiraEm = new Date(agora.getTime() + VALIDADE_EM_MS).toISOString();
  const estado: { recusa: "ja_verificado" | "muito_cedo" | null } = { recusa: null };

  const r = await alterarAppMetadata(p.admin, p.userId, (atual) => {
    // Aqui só o carimbo recusa: o cadastro novo ainda não tem pedido e precisa receber um. Quem não tem
    // pedido e pede o REENVIO é recusado logo abaixo (`somenteSePendente`).
    if (typeof atual.email_verificado_em === "string" && atual.email_verificado_em !== "") {
      estado.recusa = "ja_verificado";
      return null;
    }
    const anterior = pedidoEmAberto(atual);
    if (p.somenteSePendente && !anterior) {
      estado.recusa = "ja_verificado";
      return null;
    }
    if (
      p.intervaloMinimoMs !== undefined &&
      anterior &&
      agora.getTime() - Date.parse(anterior.enviado_em) < p.intervaloMinimoMs
    ) {
      estado.recusa = "muito_cedo";
      return null;
    }
    if (p.semGravar) return null;
    const pedido: PedidoDeVerificacao = { hash, expira_em: expiraEm, enviado_em: agora.toISOString() };
    return { ...atual, ...(p.junto ?? {}), email_verificacao: pedido };
  });

  if (!r.ok) return r;
  if (estado.recusa) return { ok: false, motivo: estado.recusa };
  return { ok: true, token, email: r.email, expiraEm, hash };
}

/**
 * Grava o pedido que `emitirPedido({ semGravar: true })` preparou, DEPOIS de o e-mail ter saído. Troca o pedido
 * anterior (o link antigo deixa de valer). Confere de novo só o carimbo: a pessoa pode ter aberto o link
 * antigo enquanto o e-mail novo ia embora, e então não há mais o que pedir.
 */
export async function gravarPedido(p: {
  admin: AdminMinimo;
  userId: string;
  hash: string;
  expiraEm: string;
  agora?: Date;
}): Promise<{ ok: true } | { ok: false; motivo: "usuario_nao_encontrado" | "gravacao_falhou" | "ja_verificado" }> {
  const agora = p.agora ?? new Date();
  const estado: { jaVerificado: boolean } = { jaVerificado: false };
  const r = await alterarAppMetadata(p.admin, p.userId, (atual) => {
    if (typeof atual.email_verificado_em === "string" && atual.email_verificado_em !== "") {
      estado.jaVerificado = true;
      return null;
    }
    const pedido: PedidoDeVerificacao = { hash: p.hash, expira_em: p.expiraEm, enviado_em: agora.toISOString() };
    return { ...atual, email_verificacao: pedido };
  });
  if (!r.ok) return r;
  if (estado.jaVerificado) return { ok: false, motivo: "ja_verificado" };
  return { ok: true };
}

export type ConsumoDoToken =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; motivo: "token_invalido" | "expirado" | "usuario_nao_encontrado" | "gravacao_falhou" };

/**
 * Confere o token e, se vale, carimba a conta e apaga o pedido (uso único). O hash é comparado em tempo
 * constante. Token de outra conta, já usado, trocado por um reenvio, ou de conta sem pedido: `token_invalido`
 * (a mesma resposta, para o link não revelar nada sobre a conta).
 */
export async function consumirToken(p: {
  admin: AdminMinimo;
  token: unknown;
  agora?: Date;
}): Promise<ConsumoDoToken> {
  const lido = lerToken(p.token);
  if (!lido) return { ok: false, motivo: "token_invalido" };
  const agora = p.agora ?? new Date();

  const estado: { desfecho: "ok" | "token_invalido" | "expirado" } = { desfecho: "token_invalido" };
  const r = await alterarAppMetadata(p.admin, lido.userId, (atual) => {
    const pedido = pedidoEmAberto(atual);
    if (!pedido) return null;
    const esperado = Buffer.from(pedido.hash, "hex");
    const recebido = Buffer.from(hashDoSegredo(lido.segredo), "hex");
    if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
    const expira = Date.parse(pedido.expira_em);
    if (!Number.isFinite(expira) || expira <= agora.getTime()) {
      estado.desfecho = "expirado";
      return null;
    }
    estado.desfecho = "ok";
    return { ...atual, email_verificado_em: agora.toISOString(), email_verificacao: null };
  });

  if (!r.ok) return r;
  if (estado.desfecho !== "ok") return { ok: false, motivo: estado.desfecho };
  return { ok: true, userId: lido.userId, email: r.email };
}
