"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuditQuery, type AuditFilters } from "@/hooks/audit/useAuditQuery";
import type { AuditEntry } from "@/hooks/audit/useAuditQuery";
import { ListaPadrao } from "@/components/redesign/ListaPadrao";
import { useRedesign } from "@/lib/redesign/contexto";

function fmtDate(iso: string, idioma: string): string {
  try {
    return new Date(iso).toLocaleString(idioma, { hour12: false });
  } catch {
    return iso;
  }
}

function truncJson(v: unknown, max = 80): string {
  if (v == null) return "—";
  const s = JSON.stringify(v);
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Quem agiu: pessoa, IA/sistema ou integração — o que o registro permite distinguir. */
function tipoDoAtor(r: AuditEntry): "pessoa" | "sistema" | "integracao" {
  if (r.acting_as_platform_admin || r.actor_user_id) return "pessoa";
  if (r.actor_api_token_id) return "integracao";
  return "sistema";
}

function rotuloDoAtor(r: AuditEntry): string {
  if (r.acting_as_platform_admin) return "platform_admin";
  if (r.actor_user_id) return r.actor_user_id.slice(0, 8);
  if (r.actor_api_token_id) return `token:${r.actor_api_token_id.slice(0, 8)}`;
  return "system";
}

export function AuditClient() {
  const ligado = useRedesign();
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [actionInput, setActionInput] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filters = useMemo<AuditFilters>(
    () => ({
      action: actionInput || undefined,
      resource_type: resourceType || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [actionInput, resourceType, from, to],
  );

  const q = useAuditQuery(filters);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);

  function handleExport() {
    const qs = new URLSearchParams();
    if (filters.action) qs.set("action", filters.action);
    if (filters.resource_type) qs.set("resource_type", filters.resource_type);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    window.location.href = `/api/v1/audit/export?${qs.toString()}`;
  }

  if (ligado) {
    const pessoasDistintas = new Set(rows.filter((r) => tipoDoAtor(r) === "pessoa").map((r) => r.actor_user_id ?? "platform_admin")).size;
    const automaticas = rows.filter((r) => tipoDoAtor(r) !== "pessoa").length;
    const qtd = (tipo: ReturnType<typeof tipoDoAtor>) => rows.filter((r) => tipoDoAtor(r) === tipo).length;
    return (
      <ListaPadrao<AuditEntry>
        rotulo={t("Histórico de ações")}
        descricao={t("Quem fez o quê e quando no sistema.")}
        acoes={
          <Button variant="outline" onClick={handleExport}>
            {t("Exportar CSV")}
          </Button>
        }
        resumo={[
          { rotulo: t("Ações carregadas"), valor: String(rows.length) },
          { rotulo: t("Pessoas distintas"), valor: String(pessoasDistintas) },
          { rotulo: t("Feitas pelo sistema ou integrações"), valor: String(automaticas) },
        ]}
        busca={{ placeholder: t("Buscar por ação, recurso ou quem fez") }}
        pilulas={[
          { id: "todas", rotulo: t("Todas"), contagem: rows.length },
          { id: "pessoa", rotulo: t("Pessoas"), contagem: qtd("pessoa") },
          { id: "integracao", rotulo: t("Integrações"), contagem: qtd("integracao") },
          { id: "sistema", rotulo: t("Sistema"), contagem: qtd("sistema") },
        ]}
        colunas={[
          { id: "quem", titulo: t("Quem"), celula: (r) => <span className="font-mono text-xs">{rotuloDoAtor(r)}</span> },
          { id: "acao", titulo: t("Ação"), celula: (r) => <span className="font-mono text-xs">{r.action}</span> },
          {
            id: "onde",
            titulo: t("Onde"),
            celula: (r) => (
              <span className="font-mono text-xs">
                {r.resource_type ?? "—"}
                {r.resource_id ? `:${r.resource_id.slice(0, 8)}` : ""}
              </span>
            ),
          },
          {
            id: "quando",
            titulo: t("Quando"),
            celula: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.created_at, tagDoIdioma)}</span>,
          },
        ]}
        linhas={rows}
        chave={(r) => r.id}
        filtrar={(r, { busca, pilula }) => {
          if (pilula !== "todas" && tipoDoAtor(r) !== pilula) return false;
          const q = busca.trim().toLowerCase();
          if (!q) return true;
          return [r.action, r.resource_type ?? "", r.resource_id ?? "", rotuloDoAtor(r)].some((x) =>
            x.toLowerCase().includes(q),
          );
        }}
        tituloDoPainel={(r) => r.action}
        painel={(r) => (
          <div className="space-y-5">
            <dl className="m-0 flex flex-col text-sm">
              {[
                [t("Quem"), rotuloDoAtor(r)],
                [t("Quando"), fmtDate(r.created_at, tagDoIdioma)],
                [t("Recurso"), `${r.resource_type ?? "—"}${r.resource_id ? `:${r.resource_id}` : ""}`],
                ["Request ID", r.request_id ?? "—"],
              ].map(([rotulo, valor]) => (
                <div
                  key={rotulo}
                  className="flex justify-between gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0"
                >
                  <dt className="flex-none text-[var(--color-text-muted)]">{rotulo}</dt>
                  <dd className="m-0 break-all text-right font-medium">{valor}</dd>
                </div>
              ))}
            </dl>
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Metadata
              </h3>
              <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-surface-elevated)] p-3 font-mono text-xs">
                {r.metadata ? JSON.stringify(r.metadata, null, 2) : "—"}
              </pre>
            </section>
          </div>
        )}
        vazio={q.isLoading ? <Skeleton className="mx-auto h-10 w-full" /> : t("Nenhum log no período.")}
        filtrosExtras={
          <>
            <div className="space-y-1">
              <label htmlFor="audit-recurso" className="block text-xs text-muted-foreground">{t("Tipo de recurso")}</label>
              <Input id="audit-recurso" value={resourceType} onChange={(e) => setResourceType(e.target.value)} placeholder="ex: contact" />
            </div>
            <div className="space-y-1">
              <label htmlFor="audit-de" className="block text-xs text-muted-foreground">{t("De")}</label>
              <Input id="audit-de" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="audit-ate" className="block text-xs text-muted-foreground">{t("Até")}</label>
              <Input id="audit-ate" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </>
        }
        rodape={
          q.hasNextPage ? (
            <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">{t("Ação contém")}</label>
            <Input
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              placeholder="ex: lead.created"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">{t("Tipo de recurso")}</label>
            <Input
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
              placeholder="ex: contact"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">{t("De")}</label>
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">{t("Até")}</label>
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button variant="outline" className="w-full" onClick={handleExport}>
              {t("Exportar CSV")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Quando")}</TableHead>
              <TableHead>{t("Ator")}</TableHead>
              <TableHead>{t("Ação")}</TableHead>
              <TableHead>{t("Recurso")}</TableHead>
              <TableHead>Request ID</TableHead>
              <TableHead>Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  {t("Nenhum log no período.")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDate(r.created_at, tagDoIdioma)}
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {r.acting_as_platform_admin
                      ? "platform_admin"
                      : r.actor_user_id
                        ? r.actor_user_id.slice(0, 8)
                        : r.actor_api_token_id
                          ? `token:${r.actor_api_token_id.slice(0, 8)}`
                          : "system"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.resource_type ?? "—"}
                    {r.resource_id ? `:${r.resource_id.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell className="font-mono text-2xs text-muted-foreground">
                    {r.request_id ? r.request_id.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-2xs text-muted-foreground">
                    {truncJson(r.metadata)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}
