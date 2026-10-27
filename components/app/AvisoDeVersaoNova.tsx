/**
 * "Nova versão disponível": a faixa no topo do CRM quando o servidor passou a
 * servir outra versão que a desta aba.
 *
 * O caso que a originou: uma aba deixada aberta durante uma publicação seguiu
 * dias na versão antiga, sem ninguém saber. O layout de `/app` entrega o build
 * id com que esta página foi montada; a faixa pergunta ao servidor o id atual
 * (`/api/v1/versao`) ao voltar para a aba e a cada 5 minutos, e só aparece com
 * CERTEZA de diferença (`lib/versao/checar.ts`) — falha de rede, sessão expirada
 * ou resposta estranha nunca acendem o aviso.
 *
 * NUNCA bloqueia: "Agora não" esconde até a próxima checagem que confirmar a
 * diferença. "Atualizar" recarrega a página.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { checarVersao } from "@/lib/versao/checar";

/** Intervalo da checagem periódica. */
export const INTERVALO_DA_CHECAGEM_MS = 5 * 60 * 1000;
/** Voltar para a aba não pergunta de novo antes disto: alternar abas não martela o servidor. */
export const INTERVALO_MINIMO_NO_FOCO_MS = 60 * 1000;

function recarregarAPagina() {
  window.location.reload();
}

export function AvisoDeVersaoNova({
  versaoCarregada,
  recarregar = recarregarAPagina,
}: {
  versaoCarregada: string | null;
  /** Só o teste troca: o jsdom não deixa observar `location.reload`. */
  recarregar?: () => void;
}) {
  const t = useT();
  const [visivel, setVisivel] = useState(false);
  const ultimaChecagem = useRef(0);
  const emAndamento = useRef(false);

  const checar = useCallback(async () => {
    if (emAndamento.current) return;
    emAndamento.current = true;
    ultimaChecagem.current = Date.now();
    try {
      const resultado = await checarVersao(versaoCarregada);
      if (resultado === "nova") setVisivel(true);
    } finally {
      emAndamento.current = false;
    }
  }, [versaoCarregada]);

  useEffect(() => {
    if (!versaoCarregada) return;
    // A primeira checagem só depois do intervalo mínimo: a página acabou de ser montada pelo servidor.
    ultimaChecagem.current = Date.now();

    const aoVoltar = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - ultimaChecagem.current < INTERVALO_MINIMO_NO_FOCO_MS) return;
      void checar();
    };
    const periodica = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void checar();
    }, INTERVALO_DA_CHECAGEM_MS);

    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      document.removeEventListener("visibilitychange", aoVoltar);
      window.clearInterval(periodica);
    };
  }, [versaoCarregada, checar]);

  if (!visivel) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="aviso-versao-nova"
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-info/40 bg-card px-4 py-2 text-sm text-foreground"
    >
      <span className="flex items-center gap-2">
        <strong className="font-semibold text-info-fg">{t("Nova versão disponível")}</strong>
        <span>{t("Atualize a página para usar a versão mais recente.")}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setVisivel(false)}
          className="rounded-md px-3 py-1 font-medium text-muted-foreground hover:bg-info-bg hover:text-foreground"
        >
          {t("Agora não")}
        </button>
        <button
          type="button"
          onClick={() => recarregar()}
          className="rounded-md border border-info/40 bg-info-bg px-3 py-1 font-medium text-info-fg hover:border-info"
        >
          {t("Atualizar")}
        </button>
      </span>
    </div>
  );
}
