"use client";

/**
 * "Em quais posts" do gatilho de comentário do Instagram: escolher entre os
 * posts recentes da conta (miniatura, legenda curta, data; vários) OU colar o
 * link de um post. Nenhum escolhido = qualquer post.
 *
 * Os posts vêm de `GET /api/v1/channels/meta-social/posts` (a organização sai
 * da sessão; só gerente para cima). Sem conta escolhida no gatilho não há de
 * onde listar: a tela diz isso em vez de mostrar uma lista vazia.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { X } from "@/lib/ui/icons";

export interface PostDaConta {
  media_id: string;
  permalink: string | null;
  legenda_curta: string | null;
  miniatura: string | null;
  tipo: string | null;
  publicado_em: string | null;
}

/** O erro da rota em português (o código vem do `fail()` da rota). */
export const ERROS_DOS_POSTS: Record<string, string> = {
  link_invalido: "Esse link não é de um post ou reel do Instagram (instagram.com/p/… ou /reel/…).",
  post_nao_encontrado: "Não achamos esse post entre os recentes desta conta.",
  conta_indisponivel: "A conta do Instagram não está disponível. Confira a conexão.",
  meta_falhou: "O Instagram não respondeu. Tente de novo em instantes.",
  rate_limited: "Muitas tentativas. Aguarde um minuto e tente de novo.",
};
const ERRO_GENERICO = "Não foi possível ler os posts da conta.";

export function fraseDoErroDosPosts(err: unknown): string {
  const codigo = err instanceof ApiError ? err.code : null;
  return (codigo && ERROS_DOS_POSTS[codigo]) || ERRO_GENERICO;
}

function dataCurta(iso: string | null, idioma: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(idioma);
}

export function EscolhaDePosts({
  prefixo,
  contas,
  escolhidos,
  max,
  onChange,
}: {
  prefixo: string;
  /** As contas escolhidas no gatilho (id + rótulo), na ordem da tela. */
  contas: Array<{ id: string; rotulo: string }>;
  escolhidos: string[];
  max: number;
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const [contaId, setContaId] = useState<string | null>(null);
  const conta = contas.find((c) => c.id === contaId) ?? contas[0] ?? null;
  const [link, setLink] = useState("");
  const [erroDoLink, setErroDoLink] = useState<string | null>(null);
  const [resolvendo, setResolvendo] = useState(false);

  const posts = useQuery({
    queryKey: ["meta-social-posts", conta?.id],
    queryFn: () =>
      apiClient.get<{ data: { posts: PostDaConta[] } }>(
        `/api/v1/channels/meta-social/posts?channel_session_id=${encodeURIComponent(conta!.id)}`,
      ),
    enabled: conta !== null,
    staleTime: 60_000,
    retry: false,
  });

  const alternar = (id: string) => {
    if (escolhidos.includes(id)) onChange(escolhidos.filter((x) => x !== id));
    else if (escolhidos.length < max) onChange([...escolhidos, id]);
  };

  const colarLink = async () => {
    const texto = link.trim();
    if (!texto || !conta) return;
    setErroDoLink(null);
    // Id numérico colado direto continua valendo (automações antigas).
    if (/^\d{5,40}$/.test(texto)) {
      if (!escolhidos.includes(texto) && escolhidos.length < max) onChange([...escolhidos, texto]);
      setLink("");
      return;
    }
    setResolvendo(true);
    try {
      const r = await apiClient.get<{ data: { media_id: string } }>(
        `/api/v1/channels/meta-social/posts?channel_session_id=${encodeURIComponent(conta.id)}&link=${encodeURIComponent(texto)}`,
      );
      const id = r.data.media_id;
      if (escolhidos.includes(id)) setErroDoLink(t("Esse post já está na lista."));
      else if (escolhidos.length >= max) setErroDoLink(t("A lista de posts está cheia."));
      else {
        onChange([...escolhidos, id]);
        setLink("");
      }
    } catch (err) {
      setErroDoLink(t(fraseDoErroDosPosts(err)));
    } finally {
      setResolvendo(false);
    }
  };

  const lista = posts.data?.data.posts ?? [];
  const porId = new Map(lista.map((p) => [p.media_id, p]));

  return (
    <fieldset className="space-y-2" data-testid={`${prefixo}-posts`}>
      <legend className="text-sm font-medium text-text">{t("Em quais posts")}</legend>
      <p className="text-xs text-text-muted">{t("Nenhum escolhido = qualquer post.")}</p>

      {escolhidos.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`${prefixo}-post-lista`}>
          {escolhidos.map((id, j) => {
            const p = porId.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs text-text"
                data-testid={`${prefixo}-post-chip-${j}`}
              >
                {p?.legenda_curta ? p.legenda_curta.slice(0, 30) : id}
                <button
                  type="button"
                  aria-label={`${t("Remover")} ${id}`}
                  onClick={() => alternar(id)}
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {!conta ? (
        <p className="text-xs text-text-muted" data-testid={`${prefixo}-posts-sem-conta`}>
          {t("Escolha a conta acima para listar os posts dela.")}
        </p>
      ) : (
        <>
          {contas.length > 1 && (
            <select
              aria-label={t("Conta dos posts")}
              className="h-8 w-full rounded-sm border border-border bg-surface px-2 text-sm text-text"
              value={conta.id}
              onChange={(e) => setContaId(e.target.value)}
              data-testid={`${prefixo}-posts-conta`}
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.rotulo}
                </option>
              ))}
            </select>
          )}
          {posts.isLoading && (
            <p className="text-xs text-text-muted">{t("Carregando os posts…")}</p>
          )}
          {posts.isError && (
            <p className="text-xs text-error-fg" role="alert" data-testid={`${prefixo}-posts-erro`}>
              {t(fraseDoErroDosPosts(posts.error))}
            </p>
          )}
          {posts.isSuccess && lista.length === 0 && (
            <p className="text-xs text-text-muted">{t("Esta conta ainda não tem posts.")}</p>
          )}
          {lista.length > 0 && (
            <ul
              className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto"
              data-testid={`${prefixo}-posts-grade`}
            >
              {lista.map((p) => {
                const marcado = escolhidos.includes(p.media_id);
                const quando = dataCurta(p.publicado_em, idioma);
                return (
                  <li key={p.media_id}>
                    <button
                      type="button"
                      aria-pressed={marcado}
                      onClick={() => alternar(p.media_id)}
                      className={`flex w-full flex-col gap-0.5 rounded-sm border p-1 text-left text-[11px] text-text ${marcado ? "border-primary ring-1 ring-primary" : "border-border"}`}
                      data-testid={`${prefixo}-post-${p.media_id}`}
                    >
                      {p.miniatura ? (
                        // eslint-disable-next-line @next/next/no-img-element -- miniatura externa da Meta, sem otimização
                        <img
                          src={p.miniatura}
                          alt=""
                          className="aspect-square w-full rounded-sm object-cover"
                        />
                      ) : (
                        <span className="aspect-square w-full rounded-sm bg-muted" aria-hidden />
                      )}
                      <span className="line-clamp-2">{p.legenda_curta ?? t("Sem legenda")}</span>
                      {quando && <span className="text-text-muted">{quando}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-1">
            <div className="flex gap-2">
              <Input
                id={`${prefixo}-post-link`}
                data-testid={`${prefixo}-post-link`}
                value={link}
                maxLength={2048}
                placeholder={t("Ou cole o link do post")}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void colarLink();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resolvendo || !link.trim()}
                onClick={() => void colarLink()}
              >
                {t("Adicionar")}
              </Button>
            </div>
            {erroDoLink && (
              <p
                className="text-xs text-error-fg"
                role="alert"
                data-testid={`${prefixo}-post-link-erro`}
              >
                {erroDoLink}
              </p>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
