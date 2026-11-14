/**
 * Leitura PURA das mensagens que o popup do Cadastro Incorporado (WhatsApp Embedded Signup)
 * manda para a janela do CRM via `window.postMessage`.
 *
 * Sem import do servidor de propósito: roda no navegador. O que chega aqui é dado hostil até
 * prova em contrário — qualquer página aberta na mesma aba pode postar mensagem —, então:
 *
 *   1. a ORIGEM é conferida pelo host (`new URL(origin).hostname`), nunca por `endsWith` na
 *      string inteira: `https://facebook.com.evil.com` termina em `.com` e contém `facebook.com`;
 *   2. só `type === "WA_EMBEDDED_SIGNUP"` interessa;
 *   3. o que não parece evento vira `null`, nunca exceção.
 *
 * O que sai daqui NUNCA é confiado pelo servidor: ele revalida o `state` e a posse do número
 * pela troca do `code`. Isto só decide o que a tela mostra e o que ela envia.
 */

export type EventoDoCadastroIncorporado =
  | {
      tipo: "finalizado";
      /** O nome do evento da Meta (`FINISH`, `FINISH_ONLY_WABA`...), repassado ao servidor como contexto. */
      evento: string;
      /** Ausente em `FINISH_ONLY_WABA`: o cadastro terminou sem escolher número. */
      phoneNumberId: string | null;
      wabaId: string | null;
    }
  | { tipo: "cancelado"; etapa: string | null }
  | { tipo: "erro"; mensagem: string };

const EVENTOS_DE_FIM = new Set([
  "FINISH",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_ONLY_WABA",
]);

function origemDaMeta(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

function registro(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** A Meta manda ids como string; aceita número por tolerância, devolve sempre string. */
function idComoTexto(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim() !== "") return valor.trim();
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return null;
}

function primeiroId(valor: unknown): string | null {
  return Array.isArray(valor) ? idComoTexto(valor[0]) : null;
}

export function lerEventoDoCadastroIncorporado(
  origin: string,
  data: unknown,
): EventoDoCadastroIncorporado | null {
  if (!origemDaMeta(origin)) return null;

  let corpo: unknown = data;
  if (typeof data === "string") {
    try {
      corpo = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const msg = registro(corpo);
  if (!msg || msg.type !== "WA_EMBEDDED_SIGNUP") return null;

  const evento = typeof msg.event === "string" ? msg.event : null;
  if (!evento) return null;
  const dados = registro(msg.data) ?? {};

  if (EVENTOS_DE_FIM.has(evento)) {
    return {
      tipo: "finalizado",
      evento,
      phoneNumberId: idComoTexto(dados.phone_number_id),
      // v4 manda `waba_id`; a v5 trocou por `messaging_account_ids` (e há `waba_ids` em alguns fluxos).
      wabaId:
        idComoTexto(dados.waba_id) ??
        primeiroId(dados.messaging_account_ids) ??
        primeiroId(dados.waba_ids),
    };
  }
  if (evento === "CANCEL") {
    return { tipo: "cancelado", etapa: idComoTexto(dados.current_step) };
  }
  if (evento === "ERROR") {
    return {
      tipo: "erro",
      mensagem: typeof dados.error_message === "string" && dados.error_message.trim() !== ""
        ? dados.error_message
        : "motivo não informado",
    };
  }
  return null;
}
