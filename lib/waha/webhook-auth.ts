/**
 * Autenticação dos webhooks do WAHA — fail-closed.
 *
 * O que existia antes era fail-OPEN: se o segredo não pudesse ser obtido
 * (`fn_decrypt_oauth` falhando, ou o campo trazendo um placeholder), a rota
 * marcava `hmacSkipped = true` e **processava o evento assim mesmo**. Como as
 * duas rotas que criam sessão gravam `webhook_secret_encrypted: Buffer.from([0])`
 * — um byte de enfeite —, esse "caso de exceção" era o estado PERMANENTE de toda
 * instalação: qualquer pessoa que soubesse a URL injetava mensagem falsa no CRM
 * alheio, escolhia o remetente e fazia o WhatsApp da vítima responder para um
 * número arbitrário (provado nesta VPS, com `curl` sem header nenhum).
 *
 * Três regras, nesta ordem:
 *
 *  1. Assinatura presente que NÃO confere ⇒ rejeita. Sempre. Não existe motivo
 *     legítimo para alguém assinar errado, e era o buraco mais óbvio.
 *  2. `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` ⇒ exige assinatura válida em tudo.
 *     Fica desligado por padrão porque sem a variável certa o WAHA não assina:
 *     medido nesta VPS (2026.7.2), os eventos reais chegavam sem header algum
 *     porque o compose entregava `WHATSAPP_HOOK_HMAC` — nome que não existe na
 *     doc dele; o certo é `WHATSAPP_HOOK_HMAC_KEY`. Ligue quando o WAHA estiver
 *     assinando ou houver um proxy que assine. Ligar isso por default
 *     derrubaria a ingestão de mensagens de todo mundo — remédio pior que a
 *     doença. Quem roda WAHA Plus (ou um proxy que assina) liga e ganha a
 *     verificação forte.
 *     Para saber se já está assinando, `/admin/sistema` mostra ao lado do
 *     interruptor se as últimas entregas chegaram assinadas e sugere ligar
 *     quando sim (`lib/channels/assinatura-das-entregas.ts`, doc 99).
 *  3. Sem assinatura e sem exigência ⇒ aceita, mas devolve `signatureVerified:
 *     false` — e quem chama grava ESSA verdade no log. Antes o log registrava
 *     `valid_signature = true` para evento não verificado.
 *
 * ─── Rota POR TOKEN (webhook que o CRM registra na sessão) ──────────────────
 *
 * A rota `[token]` passa `porToken` (com o aviso de que a decifra lançou); o
 * estado do segredo vem de `classificarSegredoDaSessao`, e aí as regras são
 * mais duras:
 *
 *  - `proprio`: a sessão tem segredo próprio, que o CRM mesmo pôs no `hmac.key`
 *    do WAHA. Assinatura ausente ou inválida ⇒ 401, qualquer que seja o
 *    interruptor do banco ou o `.env`. Só o segredo da sessão confere.
 *  - `indisponivel`: o RPC de decifra lançou (erro do banco ou pacote real que
 *    não abre). A rota responde 503 retentável; o segredo GLOBAL nunca entra.
 *  - `placeholder`: sessão antiga, sem segredo próprio (o `'\x00'` da reserva
 *    ou outro sentinela). Fica a regra de antes (segredo global, exigência do
 *    interruptor/env) até a próxima reconexão, que grava o segredo próprio.
 *
 * Sem `porToken` (rota global) nada disso vale: a regra é a de sempre.
 *
 * A defesa que não depende do WAHA saber assinar é de rede: a rota global (sem
 * token) só atende a rede interna do Docker, porque o WAHA fala com o app por
 * ali e nunca precisou dela pela internet. A própria rota recusa com 404 o que
 * traz a marca de um proxy de borda (`chegouPelaBorda`, lib/http/ip-do-cliente.ts,
 * régua válida nos proxies que o kit sobe).
 */
import { env } from "@/lib/env";
import { exigirAssinaturaNoWebhookDaInstalacao } from "@/lib/instalacao/comportamento";

import { verifyHmacSha512 } from "./ingest";

/** Curto demais para ser segredo de verdade — é placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export type WahaWebhookAuth =
  | { ok: true; signatureVerified: boolean }
  | { ok: false; reason: "bad_signature" | "signature_required" | "secret_unavailable" };

/** O estado do segredo de UMA sessão, para a rota por token. Ver o cabeçalho. */
export type SegredoDaSessao =
  | { tipo: "proprio"; segredo: string }
  | { tipo: "placeholder" }
  | { tipo: "indisponivel" };

export interface WahaWebhookAuthInput {
  rawBody: string;
  signatureHeader: string | null;
  /** Segredo por sessão já decifrado (null quando não há/não decifrou). */
  sessionSecret: string | null;
  /**
   * Só a rota POR TOKEN passa, dizendo se o RPC de decifra lançou nesta
   * leitura. Presente, liga as regras da rota por token (cabeçalho); ausente
   * (rota global), a regra é a de sempre.
   */
  porToken?: { decifraFalhou?: boolean };
}

/**
 * Classifica o segredo da sessão da rota por token.
 *
 *  - `indisponivel` só quando o RPC de decifra LANÇOU: a última
 *    `fn_decrypt_oauth` do baseline lança quando um pacote real não abre
 *    (chave mestra trocada, dado corrompido) e em erro de banco.
 *  - `proprio` com um segredo decifrado de tamanho de segredo.
 *  - todo o resto é `placeholder` (regra antiga): a função devolve NULL de
 *    propósito para o que não é pacote (o `'\x00'` da reserva, `Buffer.from([0])`
 *    de rotas antigas, lixo) — o mesmo estado que a reconexão trata como "sem
 *    segredo, gera um novo" (lib/channels/webhook-da-sessao-waha.ts).
 *    Responder 503 aí faria a sessão antiga perder mensagens até reconectar.
 */
export function classificarSegredoDaSessao(input: {
  segredo: string | null;
  decifraFalhou?: boolean;
}): SegredoDaSessao {
  if (input.decifraFalhou) return { tipo: "indisponivel" };
  if (input.segredo && input.segredo.length >= MIN_SECRET_LEN) return { tipo: "proprio", segredo: input.segredo };
  return { tipo: "placeholder" };
}

export function authenticateWahaWebhook(input: WahaWebhookAuthInput): WahaWebhookAuth {
  const { rawBody, signatureHeader, porToken } = input;
  const segredoDaSessao = porToken
    ? classificarSegredoDaSessao({ segredo: input.sessionSecret, decifraFalhou: porToken.decifraFalhou })
    : undefined;

  // Rota por token: segredo próprio exige assinatura SEMPRE, e só ele confere.
  // Segredo indisponível vira 503 na rota — nunca a conferência com o global.
  if (segredoDaSessao?.tipo === "indisponivel") return { ok: false, reason: "secret_unavailable" };
  if (segredoDaSessao?.tipo === "proprio") {
    if (!signatureHeader) return { ok: false, reason: "signature_required" };
    return verifyHmacSha512(rawBody, signatureHeader, segredoDaSessao.segredo)
      ? { ok: true, signatureVerified: true }
      : { ok: false, reason: "bad_signature" };
  }
  // `placeholder` (sessão antiga, ainda não reconectada) segue a regra de
  // antes: segredo global e exigência do interruptor/env. A sessão passa a ter
  // segredo próprio na próxima reconexão (lib/channels/webhook-da-sessao-waha.ts).
  const sessionSecret = segredoDaSessao?.tipo === "placeholder" ? null : input.sessionSecret;

  const envSecret = (env.WAHA_HMAC_SECRET ?? "").trim();
  const secret =
    sessionSecret && sessionSecret.length >= MIN_SECRET_LEN
      ? sessionSecret
      : envSecret.length >= MIN_SECRET_LEN
        ? envSecret
        : null;

  // A exigência tem DUAS camadas, com a mesma divisão de papéis da política de
  // cadastro: a linha da INSTALAÇÃO (escrita pela tela de admin) está acima, e
  // o `.env` é o PISO — ele responde quando o processo ainda não leu o banco
  // (issue #1034). Sem banco nesta vida do processo, isto é o de hoje.
  const required = exigirAssinaturaNoWebhookDaInstalacao(
    env.WAHA_WEBHOOK_REQUIRE_SIGNATURE === "true",
  );

  if (signatureHeader) {
    // Assinou: tem que conferir. Sem segredo para conferir, não há como
    // confiar — e confiar no que não dá para verificar é o defeito original.
    if (!secret) return { ok: false, reason: "bad_signature" };
    return verifyHmacSha512(rawBody, signatureHeader, secret)
      ? { ok: true, signatureVerified: true }
      : { ok: false, reason: "bad_signature" };
  }

  if (required) return { ok: false, reason: "signature_required" };
  return { ok: true, signatureVerified: false };
}
