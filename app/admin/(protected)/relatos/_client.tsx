"use client";
/**
 * Relatos de problema (migration 1018): a lista da instalação inteira, filtrada por status, e o
 * detalhe com a descrição, o contexto, o print (URL assinada de 5 min) e a troca de status.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { STATUS_DO_RELATO, caminhoRelativoSeguro, type StatusDoRelato } from "@/lib/relatos/regras";

const ROTULO_DO_STATUS: Record<StatusDoRelato, string> = {
  novo: "Novo",
  em_andamento: "Em andamento",
  resolvido: "Resolvido",
  descartado: "Descartado",
};

interface Relato {
  id: string;
  description: string;
  page_url: string | null;
  status: StatusDoRelato;
  admin_note: string | null;
  created_at: string;
  tem_print: boolean;
  empresa: string | null;
  usuario_email: string | null;
}

interface Detalhe extends Relato {
  context: Record<string, unknown>;
  print_url: string | null;
}

function dataCurta(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function RelatosClient() {
  const t = useT();
  const [status, setStatus] = useState<StatusDoRelato>("novo");
  const [linhas, setLinhas] = useState<Relato[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [aberto, setAberto] = useState<Detalhe | null>(null);

  const carregar = useCallback(
    async (depois: string | null) => {
      try {
        const q = new URLSearchParams({ status });
        if (depois) q.set("cursor", depois);
        const res = await fetch(`/api/v1/admin/bug-reports?${q.toString()}`);
        if (!res.ok) throw new Error(String(res.status));
        const corpo = (await res.json()) as { data: Relato[]; meta?: { cursor: string | null } };
        setLinhas((atuais) => (depois ? [...atuais, ...corpo.data] : corpo.data));
        setCursor(corpo.meta?.cursor ?? null);
      } catch {
        toast.error(t("Não foi possível carregar os relatos."));
      } finally {
        setCarregando(false);
      }
    },
    [status, t],
  );

  useEffect(() => {
    void carregar(null);
  }, [carregar]);

  async function abrir(id: string) {
    const res = await fetch(`/api/v1/admin/bug-reports/${id}`);
    if (!res.ok) {
      toast.error(t("Não foi possível abrir o relato."));
      return;
    }
    setAberto(((await res.json()) as { data: Detalhe }).data);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Relatos de problema")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("O que os usuários relataram pelo botão do inseto, em todas as empresas da instalação.")}
        </p>
      </div>

      <Select
        value={status}
        onValueChange={(v) => {
          setCarregando(true);
          setStatus(v as StatusDoRelato);
        }}
      >
        <SelectTrigger className="w-[200px]" aria-label={t("Status")}>
          <SelectValue placeholder={t("Status")} />
        </SelectTrigger>
        <SelectContent>
          {STATUS_DO_RELATO.map((s) => (
            <SelectItem key={s} value={s}>
              {t(ROTULO_DO_STATUS[s])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t("Data")}</th>
              <th className="px-3 py-2 font-medium">{t("Empresa")}</th>
              <th className="px-3 py-2 font-medium">{t("Usuário")}</th>
              <th className="px-3 py-2 font-medium">{t("Tela")}</th>
              <th className="px-3 py-2 font-medium">{t("Descrição")}</th>
              <th className="px-3 py-2 font-medium">{t("Status")}</th>
              <th className="px-3 py-2 font-medium">{t("Print")}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-t border-border hover:bg-muted/40"
                onClick={() => void abrir(r.id)}
              >
                <td className="whitespace-nowrap px-3 py-2">{dataCurta(r.created_at)}</td>
                <td className="px-3 py-2">{r.empresa ?? "—"}</td>
                <td className="px-3 py-2">{r.usuario_email ?? "—"}</td>
                <td className="max-w-[200px] truncate px-3 py-2">
                  {r.page_url && caminhoRelativoSeguro(r.page_url) ? (
                    <a
                      href={r.page_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline-offset-2 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.page_url}
                    </a>
                  ) : (
                    (r.page_url ?? "—")
                  )}
                </td>
                <td className="max-w-[320px] truncate px-3 py-2">{r.description.slice(0, 120)}</td>
                <td className="px-3 py-2">
                  <Badge variant="secondary">{t(ROTULO_DO_STATUS[r.status])}</Badge>
                </td>
                <td className="px-3 py-2">{r.tem_print ? t("Sim") : t("Não")}</td>
              </tr>
            ))}
            {!carregando && linhas.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  {t("Nenhum relato com este status.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {cursor && (
        <Button variant="outline" disabled={carregando} onClick={() => {
            setCarregando(true);
            void carregar(cursor);
          }}>
          {t("Carregar mais")}
        </Button>
      )}

      {aberto && (
        <DetalheDoRelato
          relato={aberto}
          aoFechar={() => setAberto(null)}
          aoSalvar={() => {
            setAberto(null);
            setCarregando(true);
            void carregar(null);
          }}
        />
      )}
    </div>
  );
}

function DetalheDoRelato({
  relato,
  aoFechar,
  aoSalvar,
}: {
  relato: Detalhe;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<StatusDoRelato>(relato.status);
  const [nota, setNota] = useState(relato.admin_note ?? "");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch(`/api/v1/admin/bug-reports/${relato.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, admin_note: nota.trim() || null }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(t("Relato atualizado."));
      aoSalvar();
    } catch {
      toast.error(t("Não foi possível salvar o relato."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Relato de problema")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {dataCurta(relato.created_at)} · {relato.empresa ?? "—"} · {relato.usuario_email ?? "—"}
          </p>
          <p className="whitespace-pre-wrap">{relato.description}</p>
          {relato.print_url && (
            <a href={relato.print_url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- URL assinada do Storage, curta */}
              <img src={relato.print_url} alt={t("Print da tela")} className="w-full rounded-md border border-border" />
            </a>
          )}
          <div>
            <p className="mb-1 font-medium">{t("Contexto")}</p>
            <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(relato.context, null, 2)}
            </pre>
          </div>
          <div className="space-y-2">
            <Select value={status} onValueChange={(v) => setStatus(v as StatusDoRelato)}>
              <SelectTrigger className="w-[200px]" aria-label={t("Status")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_DO_RELATO.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(ROTULO_DO_STATUS[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              value={nota}
              maxLength={2000}
              onChange={(e) => setNota(e.target.value)}
              placeholder={t("Nota interna (opcional)")}
              aria-label={t("Nota interna (opcional)")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            {t("Fechar")}
          </Button>
          <Button onClick={() => void salvar()} disabled={salvando}>
            {t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
