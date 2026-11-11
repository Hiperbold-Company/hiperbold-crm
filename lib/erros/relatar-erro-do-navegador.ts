/**
 * Lado do NAVEGADOR de `POST /api/v1/client-errors` (ver `erro-do-navegador.ts`).
 *
 * Regras, todas de "nunca piorar a tela que já quebrou":
 *  - uma vez por digest/mensagem por sessão da aba (`sessionStorage`), para um
 *    boundary que renderiza de novo não virar rajada;
 *  - `navigator.sendBeacon` primeiro (sobrevive à troca de página), `fetch`
 *    com `keepalive` como reserva;
 *  - nada lança: storage bloqueado, beacon recusado ou rede fora só fazem o
 *    relato não sair.
 *
 * O corte nos tetos (mensagem, pilha, rota) acontece aqui, ANTES do envio: o
 * servidor RECUSA campo acima do teto, e um erro com mensagem longa não pode
 * se perder por isso. A limpeza de dado pessoal é do servidor, que não confia
 * no que chega.
 */
import { MAX_LINHAS_DA_PILHA, MAX_MENSAGEM, MAX_NOME, MAX_PILHA, MAX_ROTA } from "./erro-do-navegador";

export const ROTA_DO_RELATO = "/api/v1/client-errors";
const CHAVE_DOS_ENVIADOS = "erros-do-navegador-enviados";

type ErroComDigest = Error & { digest?: string };

function familiaDoNavegador(ua: string): string {
  if (/SamsungBrowser/i.test(ua)) return "samsung";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "outro";
}

function jaEnviado(chave: string): boolean {
  try {
    const lista = JSON.parse(sessionStorage.getItem(CHAVE_DOS_ENVIADOS) ?? "[]") as unknown;
    const enviados = Array.isArray(lista) ? lista.filter((x): x is string => typeof x === "string") : [];
    if (enviados.includes(chave)) return true;
    sessionStorage.setItem(CHAVE_DOS_ENVIADOS, JSON.stringify([...enviados, chave].slice(-50)));
    return false;
  } catch {
    // Sem storage (modo privado, bloqueio): envia — o teto por IP do servidor segura a rajada.
    return false;
  }
}

export function relatarErroDoNavegador(error: ErroComDigest, segment?: string): void {
  try {
    if (typeof window === "undefined") return;
    const message = String(error?.message ?? "").slice(0, MAX_MENSAGEM);
    const chave = error?.digest ? `d:${error.digest}` : `m:${message}`;
    if (jaEnviado(chave)) return;

    const corpo = JSON.stringify({
      name: String(error?.name || "Error").slice(0, MAX_NOME),
      message,
      ...(error?.digest ? { digest: String(error.digest).slice(0, 64) } : {}),
      ...(segment ? { segment } : {}),
      route: window.location.pathname.slice(0, MAX_ROTA),
      ...(typeof error?.stack === "string"
        ? { stack: error.stack.split("\n").slice(0, MAX_LINHAS_DA_PILHA).join("\n").slice(0, MAX_PILHA) }
        : {}),
      ua_family: familiaDoNavegador(navigator.userAgent ?? ""),
    });

    const blob = new Blob([corpo], { type: "application/json" });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ROTA_DO_RELATO, blob)) return;
    void fetch(ROTA_DO_RELATO, {
      method: "POST",
      body: corpo,
      headers: { "content-type": "application/json" },
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    /* relatar não pode quebrar a tela de erro */
  }
}
