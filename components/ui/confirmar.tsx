"use client";

/**
 * Confirmação única do produto, no lugar de `window.confirm`, `alert` e
 * `prompt` — que o navegador bloqueia dentro de iframe, ignoram o tema e não
 * passam pela tradução.
 *
 *   const { confirmar, perguntar } = useConfirmar();
 *   if (!(await confirmar({ titulo: t("Descartar este rascunho?"), perigo: true }))) return;
 *   const motivo = await perguntar({ titulo: t("Motivo da recusa"), opcional: true });
 *
 * `confirmar` resolve `true`/`false`; `perguntar` resolve o texto digitado, ou
 * `null` quando a pessoa cancela. Fechar com Esc ou clicando fora conta como
 * cancelar. O provedor mora em `app/providers.tsx`.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export interface OpcoesDeConfirmacao {
  titulo: string;
  descricao?: string;
  /** Rótulo do botão de confirmar. Padrão: "Confirmar". */
  confirmar?: string;
  /** Rótulo do botão de cancelar. Padrão: "Cancelar". */
  cancelar?: string;
  /** Ação destrutiva: o botão de confirmar sai vermelho. */
  perigo?: boolean;
}

export interface OpcoesDePergunta extends OpcoesDeConfirmacao {
  /** Rótulo do campo de texto. */
  rotulo?: string;
  /** Deixa confirmar com o campo vazio. */
  opcional?: boolean;
}

interface Pedido {
  tipo: "confirmar" | "perguntar";
  opcoes: OpcoesDePergunta;
  resolver: (v: boolean | string | null) => void;
}

interface Api {
  confirmar: (o: OpcoesDeConfirmacao) => Promise<boolean>;
  perguntar: (o: OpcoesDePergunta) => Promise<string | null>;
}

const Contexto = createContext<Api | null>(null);

export function ProvedorDeConfirmacao({ children }: { children: ReactNode }) {
  const t = useT();
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [texto, setTexto] = useState("");
  const atual = useRef<Pedido | null>(null);

  const abrir = useCallback((tipo: Pedido["tipo"], opcoes: OpcoesDePergunta) => {
    // Um pedido novo antes de responder o anterior cancela o anterior: nada
    // fica pendurado esperando uma resposta que nunca vem.
    atual.current?.resolver(tipo === "confirmar" ? false : null);
    return new Promise<boolean | string | null>((resolver) => {
      const p = { tipo, opcoes, resolver };
      atual.current = p;
      setTexto("");
      setPedido(p);
    });
  }, []);

  const api = useRef<Api>({
    confirmar: (o) => abrir("confirmar", o) as Promise<boolean>,
    perguntar: (o) => abrir("perguntar", o) as Promise<string | null>,
  });
  // `abrir` é estável; o ref mantém a identidade da API entre renderizações.
  api.current.confirmar = (o) => abrir("confirmar", o) as Promise<boolean>;
  api.current.perguntar = (o) => abrir("perguntar", o) as Promise<string | null>;

  function responder(sim: boolean) {
    const p = atual.current;
    if (!p) return;
    atual.current = null;
    setPedido(null);
    if (p.tipo === "confirmar") p.resolver(sim);
    else p.resolver(sim ? texto.trim() : null);
  }

  const o = pedido?.opcoes;
  const faltaTexto = pedido?.tipo === "perguntar" && !o?.opcional && texto.trim() === "";

  return (
    <Contexto.Provider value={api.current}>
      {children}
      <AlertDialog open={pedido !== null} onOpenChange={(aberto) => !aberto && responder(false)}>
        <AlertDialogContent data-testid="confirmacao">
          <AlertDialogHeader>
            <AlertDialogTitle>{o?.titulo}</AlertDialogTitle>
            {o?.descricao ? <AlertDialogDescription>{o.descricao}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          {pedido?.tipo === "perguntar" ? (
            <label className="flex flex-col gap-1.5 text-sm">
              {o?.rotulo ? <span className="font-medium">{o.rotulo}</span> : null}
              <Textarea
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                aria-label={o?.rotulo ?? o?.titulo}
                rows={3}
                autoFocus
              />
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => responder(false)}>{o?.cancelar ?? t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={faltaTexto}
              className={cn(o?.perigo && buttonVariants({ variant: "destructive" }))}
              onClick={(e) => {
                e.preventDefault();
                responder(true);
              }}
            >
              {o?.confirmar ?? t("Confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Contexto.Provider>
  );
}

export function useConfirmar(): Api {
  const api = useContext(Contexto);
  if (!api) throw new Error("useConfirmar precisa do ProvedorDeConfirmacao (app/providers.tsx)");
  return api;
}
