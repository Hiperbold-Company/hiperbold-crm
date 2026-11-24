"use client";
/**
 * PADRÃO DE LISTA DO V49 — resumo de 3 números, busca, pílulas com contagem,
 * tabela e painel lateral com o detalhe da linha.
 *
 * A tela fornece dados e critério de filtro; esta peça cuida do estado (busca,
 * pílula, linha aberta) e da acessibilidade. Só é montada com o redesign
 * ligado: as cores vêm dos tokens `--color-*` do bloco `[data-redesign="ligado"]`.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { useT } from "@/hooks/i18n/useT";

export interface ItemDeResumo {
  rotulo: string;
  valor: string;
}

export interface Pilula {
  id: string;
  rotulo: string;
  contagem: number;
}

export interface ColunaDaLista<T> {
  id: string;
  titulo: string;
  celula: (linha: T) => ReactNode;
}

export interface ListaPadraoProps<T> {
  rotulo: string;
  descricao?: string;
  acoes?: ReactNode;
  resumo: ItemDeResumo[];
  busca: { placeholder: string };
  pilulas: Pilula[];
  colunas: ColunaDaLista<T>[];
  linhas: T[];
  chave: (linha: T) => string;
  filtrar: (linha: T, filtro: { busca: string; pilula: string }) => boolean;
  painel?: (linha: T, fechar: () => void) => ReactNode;
  tituloDoPainel?: (linha: T) => string;
  vazio: ReactNode;
  /** Filtros a mais (ex.: datas), entre as pílulas e a tabela. */
  filtrosExtras?: ReactNode;
  /** Conteúdo logo abaixo da tabela (ex.: "Carregar mais"). */
  rodape?: ReactNode;
}

export function ListaPadrao<T>({
  rotulo,
  descricao,
  acoes,
  resumo,
  busca: cfgBusca,
  pilulas,
  colunas,
  linhas,
  chave,
  filtrar,
  painel,
  tituloDoPainel,
  vazio,
  filtrosExtras,
  rodape,
}: ListaPadraoProps<T>) {
  const t = useT();
  const idTitulo = useId();
  const [busca, setBusca] = useState("");
  const [pilula, setPilula] = useState(pilulas[0]?.id ?? "");
  const [aberta, setAberta] = useState<string | null>(null);

  const visiveis = useMemo(
    () => linhas.filter((l) => filtrar(l, { busca, pilula })),
    [linhas, filtrar, busca, pilula],
  );
  const linhaAberta = painel && aberta !== null ? linhas.find((l) => chave(l) === aberta) : undefined;
  const fechar = () => setAberta(null);

  useEffect(() => {
    if (aberta === null) return;
    function aoTeclar(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setAberta(null);
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [aberta]);

  function aoTeclarNaLinha(e: KeyboardEvent<HTMLTableRowElement>, k: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setAberta(k);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-col gap-3.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-7 pb-3.5 pt-5">
          <div className="flex flex-wrap items-start gap-3.5">
            <div className="min-w-60 flex-1">
              <h1 className="m-0 text-xl font-bold">{rotulo}</h1>
              {descricao ? <p className="m-0 mt-1 text-sm text-[var(--color-text-muted)]">{descricao}</p> : null}
            </div>
            {acoes ? <div className="flex items-center gap-2">{acoes}</div> : null}
          </div>

          <ul aria-label={t("Resumo")} className="m-0 flex list-none flex-wrap gap-3 p-0">
            {resumo.map((r) => (
              <li
                key={r.rotulo}
                className="flex min-w-36 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5"
              >
                <strong className="text-xl font-bold leading-tight tabular-nums">{r.valor}</strong>
                <span className="text-xs text-[var(--color-text-muted)]">{r.rotulo}</span>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3.5">
            <input
              type="search"
              aria-label={cfgBusca.placeholder}
              placeholder={cfgBusca.placeholder}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="box-border h-[38px] w-[300px] max-w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
            />
            <div className="flex flex-wrap gap-2">
              {pilulas.map((p) => {
                const ativa = p.id === pilula;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={ativa}
                    onClick={() => setPilula(p.id)}
                    className={`inline-flex min-h-[30px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm ${
                      ativa
                        ? "border-[var(--color-accent-600)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-600)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    <span>{p.rotulo}</span>
                    <span
                      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-2xs font-semibold ${
                        ativa
                          ? "bg-[var(--color-accent-600)] text-[var(--color-accent-fg)]"
                          : "bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]"
                      }`}
                    >
                      {p.contagem}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {filtrosExtras ? <div className="flex flex-wrap items-end gap-3">{filtrosExtras}</div> : null}
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-7 pb-10 pt-5">
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-[var(--color-surface-elevated)]">
                  {colunas.map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      className="border-b border-[var(--color-border)] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                    >
                      {c.titulo}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visiveis.map((l) => {
                  const k = chave(l);
                  const selecionada = aberta === k && !!linhaAberta;
                  return (
                    <tr
                      key={k}
                      tabIndex={painel ? 0 : undefined}
                      aria-selected={painel ? selecionada : undefined}
                      onClick={painel ? () => setAberta(k) : undefined}
                      onKeyDown={painel ? (e) => aoTeclarNaLinha(e, k) : undefined}
                      className={`border-b border-[var(--color-border)] last:border-b-0 ${
                        painel ? "cursor-pointer hover:bg-[var(--color-surface-elevated)]" : ""
                      } ${selecionada ? "bg-[var(--color-accent-soft)]" : ""}`}
                    >
                      {colunas.map((c) => (
                        <td key={c.id} className="min-h-[58px] px-4 py-3 align-middle">
                          {c.celula(l)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visiveis.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-[var(--color-text-muted)]">{vazio}</div>
            ) : null}
          </div>
          {rodape ? <div className="mt-4 flex justify-center">{rodape}</div> : null}
        </div>
      </div>

      {painel && linhaAberta !== undefined ? (
        <aside
          role="dialog"
          aria-modal="false"
          aria-labelledby={idTitulo}
          className="fixed inset-0 z-40 flex flex-col bg-[var(--color-surface)] md:static md:inset-auto md:z-auto md:w-[440px] md:flex-none md:border-l md:border-[var(--color-border)] md:shadow-[-8px_0_24px_rgba(15,23,42,0.06)]"
        >
          <div className="flex items-start gap-2.5 border-b border-[var(--color-border)] py-4 pl-5 pr-4">
            <h2 id={idTitulo} className="m-0 min-w-0 flex-1 break-words text-lg font-bold leading-snug">
              {tituloDoPainel ? tituloDoPainel(linhaAberta) : rotulo}
            </h2>
            <button
              type="button"
              aria-label={t("Fechar painel")}
              title={t("Fechar painel")}
              onClick={fechar}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-elevated)]"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{painel(linhaAberta, fechar)}</div>
        </aside>
      ) : null}
    </div>
  );
}
