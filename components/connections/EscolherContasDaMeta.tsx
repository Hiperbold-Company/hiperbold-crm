"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/**
 * A ESCOLHA das contas da Meta (D-242). Quando a volta do OAuth traz duas ou
 * mais contas, nada foi conectado: este diálogo lista o que o login alcançou e
 * a pessoa marca só as contas DESTA empresa. Nada vem pré-marcado — um
 * operador de agência alcança as páginas de todos os clientes, e marcar tudo
 * por padrão repetiria o defeito que levou 66 páginas para a empresa errada.
 *
 * Fechar sem conectar cancela a escolha (DELETE: só apaga o cookie).
 */

export type PlataformaDaEscolha = "instagram" | "messenger";

export type ContaDaEscolha = {
  id: string;
  nome: string | null;
  usuario: string | null;
  ja_conectada_aqui: boolean;
  em_outra_empresa: boolean;
};

export type ResultadoDaEscolha = { conectadas: number; recusadas: number; motivo?: string };

const ROTA = "/api/v1/channels/meta-social/selecao";
/** O mesmo teto do servidor (o corpo do POST aceita de 1 a 20). */
export const TETO_POR_VEZ = 20;
/** A busca só aparece quando a lista passa disto. */
const LISTA_CURTA = 8;

const urlDa = (plataforma: PlataformaDaEscolha) => `${ROTA}?plataforma=${plataforma}`;

/** O texto da recusa, pela tela e não pelo servidor: o código decide, a frase segue o idioma. */
function fraseDoErro(err: unknown, t: (s: string) => string): string {
  const codigo = err instanceof ApiError ? err.code : "";
  if (codigo === "selecao_expirada" || codigo === "selecao_ja_usada")
    return t("A escolha das páginas expirou. Clique em Conectar de novo.");
  if (codigo === "selecao_de_outra_empresa")
    return t("Esta escolha foi aberta em outra empresa. Volte para ela, ou clique em Conectar de novo nesta empresa.");
  return t("Não foi possível carregar as páginas. Tente de novo.");
}

export function EscolherContasDaMeta({
  plataforma,
  aoFechar,
  aoConcluir,
}: {
  plataforma: PlataformaDaEscolha;
  /** Fechou sem conectar (cancelou, ou a escolha não vale mais). */
  aoFechar: () => void;
  /** A confirmação respondeu: o chamador mostra o aviso e recarrega as listas. */
  aoConcluir: (resultado: ResultadoDaEscolha) => void;
}) {
  const t = useT();
  const [marcadas, setMarcadas] = useState<Set<string>>(() => new Set());
  const [busca, setBusca] = useState("");

  const query = useQuery({
    queryKey: ["meta-social-escolha", plataforma],
    queryFn: async () =>
      (await apiClient.get<{ data: { plataforma: string; expira_em: string; contas: ContaDaEscolha[] } }>(urlDa(plataforma)))
        .data,
    retry: false,
    staleTime: Infinity,
  });

  const confirmar = useMutation({
    mutationFn: async (ids: string[]) =>
      (await apiClient.post<{ data: ResultadoDaEscolha }>(urlDa(plataforma), { ids })).data,
    onSuccess: (r) => aoConcluir(r),
  });

  const cancelar = () => {
    // Best-effort: o cookie vence sozinho em 10 minutos se a chamada falhar.
    void apiClient.delete(urlDa(plataforma)).catch(() => undefined);
    aoFechar();
  };

  const contas = useMemo(() => query.data?.contas ?? [], [query.data]);
  const visiveis = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase();
    if (!termo) return contas;
    return contas.filter((c) =>
      [c.nome, c.usuario].some((v) => typeof v === "string" && v.toLocaleLowerCase().includes(termo)),
    );
  }, [busca, contas]);

  const alternar = (id: string, marcar: boolean) =>
    setMarcadas((atual) => {
      const nova = new Set(atual);
      if (marcar) nova.add(id);
      else nova.delete(id);
      return nova;
    });

  const n = marcadas.size;
  const demais = n > TETO_POR_VEZ;
  const erro = query.error ?? confirmar.error;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && !confirmar.isPending && cancelar()}>
      <DialogContent data-testid="escolher-contas-meta">
        <DialogHeader>
          <DialogTitle>{t("Escolha quais páginas conectar nesta empresa")}</DialogTitle>
          <DialogDescription>
            {t("Conecte só as páginas desta empresa. Páginas de outros clientes devem ser conectadas na empresa deles.")}
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("Carregando…")}
          </p>
        ) : null}

        {erro ? (
          <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
            {fraseDoErro(erro, t)}
          </p>
        ) : null}

        {query.data ? (
          <div className="flex flex-col gap-3">
            {contas.length > LISTA_CURTA ? (
              <Input
                type="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder={t("Pesquisar...")}
                aria-label={t("Pesquisar páginas")}
              />
            ) : null}
            {visiveis.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma página encontrada para esta pesquisa.")}</p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="lista-de-contas-meta">
                {visiveis.map((c) => {
                  const titulo = c.nome ?? (c.usuario ? `@${c.usuario}` : t("Conta sem nome"));
                  const marcada = marcadas.has(c.id);
                  return (
                    <li key={c.id}>
                      <label
                        className={
                          c.em_outra_empresa
                            ? "flex cursor-not-allowed items-start gap-3 rounded-md border p-3 opacity-60"
                            : "flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/50"
                        }
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={marcada}
                          disabled={c.em_outra_empresa || confirmar.isPending}
                          onChange={(e) => alternar(c.id, e.target.checked)}
                          aria-label={titulo}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{titulo}</span>
                          {c.nome && c.usuario ? (
                            <span className="block truncate text-sm text-muted-foreground">@{c.usuario}</span>
                          ) : null}
                          {c.em_outra_empresa ? (
                            <span className="block text-xs text-muted-foreground">{t("Já conectada em outra empresa")}</span>
                          ) : c.ja_conectada_aqui ? (
                            <span className="block text-xs text-muted-foreground">{t("Já conectada aqui")}</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {demais ? (
              <p role="alert" className="text-sm text-destructive">
                {t("Marque no máximo 20 páginas por vez.")}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={cancelar} disabled={confirmar.isPending}>
            {t("Cancelar")}
          </Button>
          {query.data ? (
            <Button
              onClick={() => confirmar.mutate([...marcadas])}
              disabled={n === 0 || demais || confirmar.isPending}
              data-testid="confirmar-contas-meta"
            >
              {t("Conectar")} {n}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
