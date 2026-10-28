"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatRelative, isToday, isYesterday } from "date-fns";
import { toast } from "sonner";
import { CaretDown, CaretUp, ChatCircle, Trash } from "@/lib/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useDeleteContact } from "@/hooks/contacts/useDeleteContact";
import type { ContactOrderBy } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { COLUNAS_DO_SISTEMA, COLUNAS_PADRAO, PREFIXO_DE_CAMPO } from "@/lib/contacts/colunas-da-lista";
import { rotuloDaOrigem } from "@/lib/contacts/origens";

/** A seleção em lote, quando a pessoa pode usá-la (exclusão pede `agent`). Ausente = sem caixas. */
export interface SelecaoDaTabela {
  ids: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Marca (ou desmarca) todas as linhas que a tabela mostra. */
  onTogglePagina: (marcar: boolean) => void;
}

interface Props {
  contacts: Contact[];
  selecao?: SelecaoDaTabela;
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
  /**
   * As colunas, na ordem (`lib/contacts/colunas-da-lista.ts`). Ausente = as 7 de sempre.
   * "nome" e "acoes" vêm sempre — quem garante é `normalizarColunas`.
   */
  colunas?: readonly string[];
  /** Rótulo de cada campo personalizado do contato (`cf:<chave>`); sem rótulo, a chave. */
  rotulosDeCampo?: ReadonlyMap<string, string>;
}

/** Valor de campo personalizado como texto de célula. */
function textoDoCampo(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function displayName(c: Contact, t: (texto: string) => string = (texto) => texto): string {
  return rotuloDoContato(c, t);
}

/** Hoje/ontem: relativo ("há 2 horas", "ontem"). Mais antigo: data, não dia da semana. */
// `locale` ANTES de `now`, e não depois: `now` tem default, e um parâmetro
// obrigatório atrás de um opcional obriga todo chamador a passar os dois. O
// codemod acrescentou no fim, que é o certo em 22 dos 23 casos e o errado aqui.
function formatUltimaAtividade(iso: string, locale: Locale, now = new Date()): string {
  const d = new Date(iso);
  if (isToday(d) || isYesterday(d)) {
    return formatRelative(d, now, { locale: locale });
  }
  return format(d, "dd/MM/yyyy", { locale: locale });
}

function SortableHead({
  label,
  column,
  orderBy,
  orderDir,
  onSort,
  className,
}: {
  label: string;
  column: ContactOrderBy;
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
  className?: string;
}) {
  const active = orderBy === column;
  const muted = "text-muted-foreground";
  const emphasis = "text-foreground";

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
        aria-sort={active ? (orderDir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="inline-flex flex-col -space-y-1" aria-hidden>
          <CaretUp
            size={12}
            weight="bold"
            className={active && orderDir === "asc" ? emphasis : muted}
          />
          <CaretDown
            size={12}
            weight="bold"
            className={active && orderDir === "desc" ? emphasis : muted}
          />
        </span>
      </button>
    </TableHead>
  );
}

/** Caixa de seleção nativa: acessível por teclado e leitor de tela sem biblioteca nova. */
function CaixaDeSelecao({
  marcada,
  indeterminada = false,
  desabilitada = false,
  onChange,
  rotulo,
}: {
  marcada: boolean;
  indeterminada?: boolean;
  desabilitada?: boolean;
  onChange: (marcada: boolean) => void;
  rotulo: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminada && !marcada;
  }, [indeterminada, marcada]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded-sm border-border accent-[var(--color-accent,currentColor)]"
      checked={marcada}
      disabled={desabilitada}
      aria-label={rotulo}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function ContactsTable({
  contacts,
  selecao,
  orderBy,
  orderDir,
  onSort,
  colunas = COLUNAS_PADRAO,
  rotulosDeCampo,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const clientesLigado = useActiveOrg()?.cliente_pela_agenda === true;
  const del = useDeleteContact();
  const [alvo, setAlvo] = useState<Contact | null>(null);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  const router = useRouter();
  const qc = useQueryClient();

  async function iniciarConversa(c: Contact) {
    if (!c.phone_number || abrindo) return;
    setAbrindo(c.id);
    try {
      const res = await fetch("/api/v1/conversations/open-with-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: c.id, phone_number: c.phone_number }),
      });
      const json = (await res.json()) as {
        data?: { conversation_id: string };
        error?: { message?: string };
      };
      if (!res.ok || !json.data?.conversation_id) {
        throw new Error(json.error?.message ?? t("Não foi possível abrir a conversa."));
      }
      await qc.invalidateQueries({ queryKey: ["contacts"] });
      router.push(`/app/inbox?id=${json.data.conversation_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Não foi possível abrir a conversa."));
    } finally {
      setAbrindo(null);
    }
  }

  async function confirmarExclusao() {
    if (!alvo) return;
    try {
      await del.mutateAsync(alvo.id);
      toast.success(t("Contato excluído."));
      setAlvo(null);
    } catch {
      // hook handles toast
    }
  }

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          {selecao && (
            <TableHead className="w-10">
              <CaixaDeSelecao
                rotulo={t("Selecionar esta página")}
                marcada={
                  contacts.some((c) => !c.is_anonymized) &&
                  contacts.filter((c) => !c.is_anonymized).every((c) => selecao.ids.has(c.id))
                }
                indeterminada={contacts.some((c) => selecao.ids.has(c.id))}
                onChange={selecao.onTogglePagina}
              />
            </TableHead>
          )}
          {colunas.map((id) => {
            const ordem = { orderBy, orderDir, onSort };
            switch (id) {
              case "nome":
                return <SortableHead key={id} label={t("Nome")} column="display_name" {...ordem} />;
              case "email":
                return <SortableHead key={id} label={t("Email")} column="email" {...ordem} />;
              case "telefone":
                return <SortableHead key={id} label={t("Telefone")} column="phone_number" {...ordem} />;
              case "ultima_atividade":
                return (
                  <SortableHead key={id} label={t("Última atividade")} column="last_activity_at" {...ordem} />
                );
              case "entrou_no_crm":
                return <SortableHead key={id} label={t("Entrou no CRM")} column="created_at" {...ordem} />;
              case "acoes":
                return (
                  <TableHead key={id} className="w-[88px]">
                    <span className="sr-only">{t("Ações")}</span>
                  </TableHead>
                );
              default: {
                const doSistema = COLUNAS_DO_SISTEMA.find((c) => c.id === id);
                const chave = id.slice(PREFIXO_DE_CAMPO.length);
                return (
                  <TableHead key={id}>{doSistema ? t(doSistema.rotulo) : (rotulosDeCampo?.get(chave) ?? chave)}</TableHead>
                );
              }
            }
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {contacts.map((c) => (
          <TableRow
            key={c.id}
            className="cursor-pointer"
            data-state={selecao?.ids.has(c.id) ? "selected" : undefined}
          >
            {selecao && (
              <TableCell className="w-10">
                <CaixaDeSelecao
                  rotulo={`${t("Selecionar")} ${displayName(c, t)}`}
                  marcada={selecao.ids.has(c.id)}
                  // Anonimizado (LGPD) aparece, mas não entra no lote nem na exportação.
                  desabilitada={Boolean(c.is_anonymized)}
                  onChange={() => selecao.onToggle(c.id)}
                />
              </TableCell>
            )}
            {colunas.map((id) => {
              switch (id) {
                case "nome":
                  return (
                  <TableCell key="nome" className="font-medium">
                    <Link href={`/app/contacts/${c.id}`} className="hover:underline">
                      {displayName(c)}
                    </Link>
                  </TableCell>
                  );
                case "email":
                  return (
                  <TableCell key="email" className="text-muted-foreground">
                    {c.email ?? "—"}
                  </TableCell>
                  );
                case "telefone":
                  return (
                  <TableCell key="telefone" className="text-muted-foreground">
                    {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
                  </TableCell>
                  );
                case "tags":
                  return (
                  <TableCell key="tags">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.length === 0
                        ? <span className="text-muted-foreground text-xs">—</span>
                        : c.tags.map((tag) => (
                            <ChipDeEtiqueta key={tag} tag={tag} />
                          ))}
                    </div>
                  </TableCell>
                  );
                case "ultima_atividade":
                  return (
                  <TableCell key="ultima_atividade" className="text-muted-foreground text-sm">
                    {c.last_activity_at
                      ? formatUltimaAtividade(c.last_activity_at, localeDaData)
                      : "—"}
                  </TableCell>
                  );
                case "status":
                  return (
                  <TableCell key="status">
                    <div className="flex flex-wrap gap-1">
                      {c.is_anonymized && <Badge variant="destructive">{t("Anonimizado")}</Badge>}
                      {c.is_blocked && <Badge variant="warning">{t("Bloqueado")}</Badge>}
                      {/*
                        Lê a COLUNA, nunca a tag, e só com a regra ligada: a tag
                        `cliente` é removível à mão e pelo PATCH (que substitui `tags`
                        por inteiro), e um selo que some porque alguém editou
                        etiquetas mentiria sobre um fato. Desligada, a coluna está
                        congelada e o selo mentiria do outro lado.
                      */}
                      {clientesLigado && c.first_service_at && (
                        <Badge variant="secondary">{t("Cliente")}</Badge>
                      )}
                      {!c.is_anonymized && !c.is_blocked && (
                        <Badge variant="success">{t("Ativo")}</Badge>
                      )}
                    </div>
                  </TableCell>
                  );
                case "acoes":
                  return (
                  <TableCell key="acoes">
                    <div className="flex items-center justify-end gap-0.5">
                      {c.conversa ? (
                        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                          <Link
                            href={`/app/inbox?id=${c.conversa.id}`}
                            title={t("Abrir conversa no Inbox")}
                            aria-label={`${t("Abrir conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                          >
                            <ChatCircle size={16} weight="regular" aria-hidden />
                            {c.conversa.unread > 0 && (
                              <span className="sr-only">{c.conversa.unread} {t("sem ler")}</span>
                            )}
                          </Link>
                        </Button>
                      ) : c.phone_number ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={t("Iniciar conversa no Inbox")}
                          aria-label={`${t("Iniciar conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                          disabled={abrindo === c.id}
                          onClick={() => void iniciarConversa(c)}
                        >
                          <ChatCircle size={16} weight="regular" aria-hidden />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-error-fg"
                        title={t("Excluir contato")}
                        aria-label={`${t("Excluir contato")} ${displayName(c, t)}`}
                        onClick={() => setAlvo(c)}
                      >
                        <Trash size={16} weight="regular" aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                  );
                case "entrou_no_crm":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm">
                      {format(new Date(c.created_at), "dd/MM/yyyy", { locale: localeDaData })}
                    </TableCell>
                  );
                case "origem":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm">
                      {c.source ? t(rotuloDaOrigem(c.source)) : "—"}
                    </TableCell>
                  );
                case "aniversario":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm">
                      {c.birthdate ? format(new Date(`${c.birthdate}T12:00:00`), "dd/MM/yyyy", { locale: localeDaData }) : "—"}
                    </TableCell>
                  );
                case "ultima_mensagem":
                  return (
                    <TableCell key={id} className="max-w-[16rem] truncate text-muted-foreground text-sm">
                      {c.conversa?.preview ?? "—"}
                    </TableCell>
                  );
                default:
                  return (
                    <TableCell key={id} className="max-w-[14rem] truncate text-muted-foreground text-sm">
                      {textoDoCampo(c.custom_fields?.[id.slice(PREFIXO_DE_CAMPO.length)])}
                    </TableCell>
                  );
              }
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>

    <AlertDialog open={alvo !== null} onOpenChange={(open) => { if (!open) setAlvo(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir contato?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {alvo
              ? `${t("Isso remove")} ${displayName(alvo, t)} ${t("e a conversa associada, se houver. Esta ação não pode ser desfeita.")}`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>{t("Cancelar")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => void confirmarExclusao()}
            disabled={del.isPending}
          >
            {del.isPending ? t("Excluindo…") : t("Excluir")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
