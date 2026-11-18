"use client";
/**
 * "Relatar problema" (migration 1018): a aba com o inseto presa à borda direita, só no computador.
 *
 * Ao clicar, o print da tela é tirado ANTES de o modal abrir (o modal não sai no print). Se a
 * captura falhar ou demorar, o relato segue sem print e sem aviso de erro. Junto vai o contexto:
 * a tela (sem o hash), o user agent, a viewport, o idioma e os últimos erros do console desta aba.
 *
 * Altura: `bottom-48` (192 px). Os toasts ficam no canto inferior direito a 32 px da borda (não
 * tocam a aba de 28 px visíveis), e o compositor do chat e o aviso de proposta ocupam os primeiros
 * ~170 px de baixo; a aba fica acima dos dois.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIdioma, useT } from "@/lib/i18n/IdiomaProvider";
import {
  DESCRICAO_MAX,
  DESCRICAO_MIN,
  MAX_ERRO_DO_CONSOLE,
  MAX_ERROS_DO_CONSOLE,
  PRINT_MAX_BYTES,
} from "@/lib/relatos/regras";
import { Bug } from "@/lib/ui/icons";

/** A captura que demora mais que isto conta como falha. */
const TEMPO_MAXIMO_DA_CAPTURA_MS = 4000;
const LARGURA_MAXIMA_DO_PRINT = 1600;
const ATRIBUTO_FORA_DO_PRINT = "data-fora-do-print";

/** Troca o import dinâmico no teste. */
export type Capturar = () => Promise<Blob | null>;

function dataUrlParaBlob(dataUrl: string): Blob | null {
  const [cabecalho, base64] = dataUrl.split(",", 2);
  const tipo = /^data:([^;]+);base64$/.exec(cabecalho ?? "")?.[1];
  if (!tipo || !base64) return null;
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: tipo });
}

/** O print da área visível, em WebP, sem os elementos marcados como fora do print. */
const capturarTela: Capturar = async () => {
  const { domToWebp } = await import("modern-screenshot");
  const largura = window.innerWidth;
  const dataUrl = await domToWebp(document.body, {
    width: largura,
    height: window.innerHeight,
    scale: Math.min(1, LARGURA_MAXIMA_DO_PRINT / Math.max(1, largura)),
    quality: 0.7,
    filter: (no) => !(no instanceof Element && no.hasAttribute(ATRIBUTO_FORA_DO_PRINT)),
  });
  return dataUrlParaBlob(dataUrl);
};

async function capturarComTeto(capturar: Capturar): Promise<Blob | null> {
  try {
    const blob = await Promise.race([
      capturar(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TEMPO_MAXIMO_DA_CAPTURA_MS)),
    ]);
    if (!blob || blob.size === 0 || blob.size > PRINT_MAX_BYTES) return null;
    return blob;
  } catch {
    return null;
  }
}

export function RelatarProblema({ capturar = capturarTela }: { capturar?: Capturar }) {
  const t = useT();
  const idioma = useIdioma();
  const erros = useRef<string[]>([]);
  const [aberto, setAberto] = useState(false);
  const [capturando, setCapturando] = useState(false);
  const [print, setPrint] = useState<Blob | null>(null);
  const [incluirPrint, setIncluirPrint] = useState(true);
  const [descricao, setDescricao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [tentouEnviar, setTentouEnviar] = useState(false);

  // Os últimos erros desta aba, para o relato chegar com o que o console viu.
  useEffect(() => {
    const guardar = (texto: string) => {
      erros.current = [...erros.current, texto.slice(0, MAX_ERRO_DO_CONSOLE)].slice(-MAX_ERROS_DO_CONSOLE);
    };
    const aoErro = (e: ErrorEvent) => guardar(e.message || String(e.error ?? "erro"));
    const aoRejeitar = (e: PromiseRejectionEvent) => {
      const motivo = e.reason instanceof Error ? e.reason.message : String(e.reason);
      guardar(`unhandledrejection: ${motivo}`);
    };
    window.addEventListener("error", aoErro);
    window.addEventListener("unhandledrejection", aoRejeitar);
    return () => {
      window.removeEventListener("error", aoErro);
      window.removeEventListener("unhandledrejection", aoRejeitar);
    };
  }, []);

  const miniatura = useMemo(() => (print ? URL.createObjectURL(print) : null), [print]);
  useEffect(
    () => () => {
      if (miniatura) URL.revokeObjectURL(miniatura);
    },
    [miniatura],
  );

  async function abrir() {
    if (capturando) return;
    setCapturando(true);
    const blob = await capturarComTeto(capturar);
    setPrint(blob);
    setIncluirPrint(true);
    setDescricao("");
    setTentouEnviar(false);
    setCapturando(false);
    setAberto(true);
  }

  const texto = descricao.trim();
  const descricaoValida = texto.length >= DESCRICAO_MIN && texto.length <= DESCRICAO_MAX;

  async function enviar() {
    setTentouEnviar(true);
    if (!descricaoValida || enviando) return;
    setEnviando(true);
    try {
      const form = new FormData();
      form.set("description", texto);
      form.set(
        "context",
        JSON.stringify({
          url: `${window.location.pathname}${window.location.search}`,
          user_agent: navigator.userAgent.slice(0, 500),
          viewport: { largura: window.innerWidth, altura: window.innerHeight },
          idioma,
          erros: erros.current,
        }),
      );
      if (incluirPrint && print) {
        form.set("screenshot", print, print.type === "image/png" ? "print.png" : "print.webp");
      }
      const res = await fetch("/api/v1/bug-reports", { method: "POST", body: form });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(corpo?.error?.message ?? t("Não foi possível enviar o relato. Tente de novo."));
        return;
      }
      toast.success(t("Recebemos o seu relato. Obrigado!"));
      setAberto(false);
      setPrint(null);
    } catch {
      toast.error(t("Não foi possível enviar o relato. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="relatar-problema"
            {...{ [ATRIBUTO_FORA_DO_PRINT]: "" }}
            aria-label={t("Relatar problema")}
            onClick={() => void abrir()}
            disabled={capturando}
            className="fixed right-0 bottom-48 z-40 hidden h-10 w-9 translate-x-2 items-center justify-center rounded-l-lg border border-r-0 border-border bg-card text-muted-foreground shadow-md transition-transform hover:translate-x-0 hover:text-foreground focus-visible:translate-x-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 lg:flex"
          >
            <Bug size={18} weight="bold" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t("Relatar problema")}</TooltipContent>
      </Tooltip>
      </TooltipProvider>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-lg" {...{ [ATRIBUTO_FORA_DO_PRINT]: "" }}>
          <DialogHeader>
            <DialogTitle>{t("Relatar um problema")}</DialogTitle>
            <DialogDescription className="sr-only">{t("Relatar problema")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void enviar();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="relato-descricao" className="block text-sm font-medium">
                {t("Descreva o problema encontrado")}
              </label>
              <Textarea
                id="relato-descricao"
                maxLength={DESCRICAO_MAX}
                rows={5}
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                aria-invalid={tentouEnviar && !descricaoValida}
              />
              {tentouEnviar && !descricaoValida && (
                <p className="text-xs text-error-fg" role="alert">
                  {t("Descreva o problema com 10 a 2000 caracteres.")}
                </p>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("Podemos incluir um print da tela atual?")}</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="relato-incluir-print"
                    checked={incluirPrint}
                    onChange={() => setIncluirPrint(true)}
                  />
                  {t("Sim")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="relato-incluir-print"
                    checked={!incluirPrint}
                    onChange={() => setIncluirPrint(false)}
                  />
                  {t("Não")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("O seu print-screen nos ajudará a resolver o problema mais rapidamente.")}
              </p>
              {incluirPrint && miniatura && (
                // eslint-disable-next-line @next/next/no-img-element -- blob local, sem otimização possível
                <img
                  src={miniatura}
                  alt={t("Print da tela")}
                  className="max-h-40 w-auto rounded-md border border-border"
                />
              )}
            </fieldset>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAberto(false)}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={enviando}>
                {t("Enviar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
