"use client";

/**
 * O ACORDEÃO da página Etapas do funil — cada funil vira um card recolhível.
 *
 * Com um funil por edição de programa ("PMA 2027", "PMA 2028"…) a página mostrava todos abertos e ficava
 * enorme. Fechado por padrão; abre sozinho quando:
 * - há um funil só;
 * - a URL aponta para uma âncora dentro dele (`#etapas-<id>`, `#mapeamento-<id>`), na abertura e quando o
 *   hash muda — os links "ir para as etapas" / "ir para o mapeamento" de `_stages.tsx` e `_mapping.tsx`
 *   continuam levando ao lugar certo;
 * - é o funil que acabou de ser duplicado;
 * - alguém clica num link da página para uma dessas âncoras — inclusive com o MESMO hash já na URL, caso em
 *   que o navegador não dispara `hashchange`.
 *
 * Com um funil só não há o que recolher: o cabeçalho aparece sem a seta e sem o clique.
 *
 * Os botões de duplicar só aparecem para quem tem `funis.editar` (a rota recusa o resto com 403).
 *
 * ⚠️ RECOLHER SÓ ESCONDE (`hidden`), NÃO DESMONTA: desmontar apagaria em silêncio o que foi editado e ainda
 * não salvo nas seções de dentro.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, Copy } from "@/lib/ui/icons";
import { ancoraDoMapeamento } from "./_mapping";
import { ancoraDasEtapas } from "./_stages";
import { DialogoDuplicarFunil, type FunilDeOrigem } from "./_duplicar-funil";

/** O id do bloco que envolve o card do funil — é para ele que a página rola depois de duplicar. */
export const ancoraDoFunil = (pipelineId: string) => `funil-${pipelineId}`;

/** De qual funil é a âncora do hash (`#etapas-<id>`, `#mapeamento-<id>`, `#funil-<id>`), ou `null`. */
export function funilDoHash(hash: string, ids: readonly string[]): string | null {
  const alvo = hash.replace(/^#/, "");
  if (!alvo) return null;
  return (
    ids.find((id) => alvo === ancoraDasEtapas(id) || alvo === ancoraDoMapeamento(id) || alvo === ancoraDoFunil(id)) ??
    null
  );
}

interface EstadoDoAcordeao {
  aberto: (id: string) => boolean;
  alternar: (id: string) => void;
  /** `null` quando a pessoa não pode duplicar: o botão do card não aparece. */
  duplicar: ((origemId: string) => void) | null;
  /** Um funil só: nada a recolher. */
  sozinho: boolean;
}

const Contexto = createContext<EstadoDoAcordeao | null>(null);

/** Quanto esperar o `router.refresh()` trazer o funil novo antes de recarregar a página. */
const ESPERA_DO_FUNIL_NOVO_MS = 4000;

function rolarAte(id: string) {
  // `requestAnimationFrame`: o bloco acabou de deixar de ser `hidden`, e rolar antes do layout não acha nada.
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
}

export function AcordeaoDosFunis({
  pipelines: funis,
  podeDuplicar,
  children,
}: {
  pipelines: FunilDeOrigem[];
  /** `funis.editar` da pessoa (`papelPode`), o mesmo critério da rota de duplicar. */
  podeDuplicar: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const ids = useMemo(() => funis.map((f) => f.id), [funis]);
  const [abertos, setAbertos] = useState(() => new Set<string>(funis.length === 1 ? ids : []));
  const [dialogo, setDialogo] = useState<{ origemId: string } | null>(null);
  // O funil recém-duplicado que o refresh ainda não trouxe, e o relógio do plano B (recarregar).
  const pendente = useRef<{ id: string; espera: number } | null>(null);
  // O ouvinte do hash é registrado uma vez e lê a lista ATUAL por aqui (o efeito roda antes do do hash).
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  const abrir = useCallback((id: string) => {
    setAbertos((atual) => (atual.has(id) ? atual : new Set(atual).add(id)));
  }, []);

  // O hash abre o funil dono da âncora — na abertura e sempre que muda.
  useEffect(() => {
    const segueOHash = () => {
      const id = funilDoHash(window.location.hash, idsRef.current);
      if (!id) return;
      abrir(id);
      rolarAte(window.location.hash.slice(1));
    };
    // O clique num link para a âncora: com o MESMO hash já na URL não há `hashchange`, e o card seguiria
    // fechado. Com hash diferente o `hashchange` também vem; abrir duas vezes não muda nada.
    const segueOClique = (ev: MouseEvent) => {
      const link = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!href || !href.includes("#")) return;
      let destino: URL;
      try {
        destino = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (destino.pathname !== window.location.pathname) return;
      const id = funilDoHash(destino.hash, idsRef.current);
      if (!id) return;
      abrir(id);
      if (destino.hash === window.location.hash) rolarAte(destino.hash.slice(1));
    };
    segueOHash();
    window.addEventListener("hashchange", segueOHash);
    document.addEventListener("click", segueOClique);
    return () => {
      window.removeEventListener("hashchange", segueOHash);
      document.removeEventListener("click", segueOClique);
    };
  }, [abrir]);

  // O funil recém-duplicado: quando o refresh o traz, a página rola até ele (já está aberto: `onDuplicado`).
  useEffect(() => {
    const p = pendente.current;
    if (!p || !ids.includes(p.id)) return;
    window.clearTimeout(p.espera);
    pendente.current = null;
    rolarAte(ancoraDoFunil(p.id));
  }, [ids]);
  useEffect(() => () => window.clearTimeout(pendente.current?.espera), []);

  // Um funil só: aberto, sem estado — vale também se a lista encolher para um depois da abertura.
  const estaAberto = useCallback((id: string) => ids.length === 1 || abertos.has(id), [ids, abertos]);
  const todosAbertos = ids.length > 0 && ids.every(estaAberto);
  const estado = useMemo<EstadoDoAcordeao>(
    () => ({
      aberto: estaAberto,
      alternar: (id) =>
        setAbertos((atual) => {
          const novo = new Set(atual);
          if (novo.has(id)) novo.delete(id);
          else novo.add(id);
          return novo;
        }),
      duplicar: podeDuplicar ? (origemId) => setDialogo({ origemId }) : null,
      sozinho: ids.length === 1,
    }),
    [estaAberto, podeDuplicar, ids.length],
  );

  return (
    <Contexto.Provider value={estado}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {ids.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="alternar-todos-os-funis"
              onClick={() => setAbertos(todosAbertos ? new Set() : new Set(ids))}
            >
              {todosAbertos ? t("Fechar todos") : t("Abrir todos")}
            </Button>
          )}
          {podeDuplicar && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="duplicar-funil"
              onClick={() => setDialogo({ origemId: ids[0] ?? "" })}
            >
              <Copy size={14} aria-hidden className="mr-1" />
              {t("Duplicar funil")}
            </Button>
          )}
        </div>
        {children}
      </div>
      {/* Montado só quando aberto: o diálogo usa o roteador, e a lista não precisa dele para existir. */}
      {podeDuplicar && dialogo && (
        <DialogoDuplicarFunil
          funis={funis}
          origemInicial={dialogo.origemId}
          onFechar={() => setDialogo(null)}
          onDuplicado={(novoId) => {
            setDialogo(null);
            abrir(novoId);
            // Se o refresh não trouxer o funil novo (pode ser atropelado pelos prefetches; ver
            // `hooks/pipelines/usePipelines.ts`), recarrega a página já com o hash dele, que o abre.
            window.clearTimeout(pendente.current?.espera);
            pendente.current = {
              id: novoId,
              espera: window.setTimeout(() => {
                window.location.hash = ancoraDoFunil(novoId);
                window.location.reload();
              }, ESPERA_DO_FUNIL_NOVO_MS),
            };
          }}
        />
      )}
    </Contexto.Provider>
  );
}

export function AcordeaoDoFunil({
  pipeline,
  numeroDeEtapas,
  children,
}: {
  pipeline: { id: string; name: string; slug: string; is_default?: boolean };
  numeroDeEtapas: number;
  children: ReactNode;
}) {
  const t = useT();
  const estado = useContext(Contexto);
  const aberto = estado ? estado.aberto(pipeline.id) : true;
  // Sem o provedor (uso isolado) ou com um funil só, não há o que recolher.
  const recolhivel = !!estado && !estado.sozinho;
  const corpo = `corpo-do-funil-${pipeline.id}`;
  const duplicar = estado?.duplicar ?? null;

  // O que o cabeçalho diz: nome, selo e contagem. Só `span` — vai dentro de `<button>` e de `<h2>`.
  const rotulo = (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{pipeline.name}</span>
      {pipeline.is_default && (
        <span className={badgeVariants({ variant: "secondary", className: "text-[10px]" })}>{t("Padrão")}</span>
      )}
      <span className="text-xs font-normal text-muted-foreground">
        {numeroDeEtapas === 1 ? t("1 etapa") : `${numeroDeEtapas} ${t("etapas")}`}
      </span>
    </span>
  );

  return (
    <Card id={ancoraDoFunil(pipeline.id)} className="p-6" data-testid={`funil-${pipeline.id}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* O padrão acessível do acordeão: o botão DENTRO do título, não o título dentro do botão. */}
          <h2 className="text-base font-semibold">
            {recolhivel ? (
              <button
                type="button"
                aria-expanded={aberto}
                aria-controls={corpo}
                onClick={() => estado?.alternar(pipeline.id)}
                className="flex w-full min-w-0 items-start gap-2 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`alternar-funil-${pipeline.id}`}
              >
                <CaretDown
                  size={16}
                  aria-hidden
                  className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${aberto ? "" : "-rotate-90"}`}
                />
                {rotulo}
              </button>
            ) : (
              rotulo
            )}
          </h2>
          <p className={`text-xs text-muted-foreground ${recolhivel ? "pl-6" : ""}`}>/{pipeline.slug}</p>
        </div>
        {duplicar && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`duplicar-funil-${pipeline.id}`}
            onClick={() => duplicar(pipeline.id)}
          >
            <Copy size={14} aria-hidden className="mr-1" />
            {t("Duplicar")}
          </Button>
        )}
      </header>
      <div id={corpo} hidden={!aberto} className="mt-6 space-y-6">
        {children}
      </div>
    </Card>
  );
}
