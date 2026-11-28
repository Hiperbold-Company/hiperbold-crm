"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { useAdminInbox, type AdminConversationRow } from "@/hooks/useAdminInbox";
import { useAdminInboxRealtime } from "@/hooks/useAdminInboxRealtime";
import { TenantBadge } from "@/components/admin/inbox/TenantBadge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CircleNotch, MagnifyingGlass } from "@/lib/ui/icons";
import { ApiError } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebounced(value), delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

function contactName(row: AdminConversationRow, t: (texto: string) => string): string {
  return row.contacts?.name?.trim() || row.contacts?.phone_number || t("Sem nome");
}

// ---------------------------------------------------------------------------
// Status filter options
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendente" },
  { value: "open", label: "Aberto" },
  { value: "resolved", label: "Resolvido" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InboxList() {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const router = useRouter();
  const params = useParams();
  const selectedId = params?.conversationId as string | undefined;

  const [rawSearch, setRawSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "open" | "resolved">("all");
  const [tenantFilter] = useState<string | undefined>(undefined);

  const debouncedSearch = useDebounced(rawSearch, 300);

  // Realtime: invalidates ["admin", "inbox"] on message INSERT
  useAdminInboxRealtime();

  const filters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      tenant_id: tenantFilter,
    }),
    [debouncedSearch, statusFilter, tenantFilter],
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useAdminInbox(filters);

  const pedeAcompanhamento =
    isError && error instanceof ApiError && error.code === "support_session_required";

  const rows = useMemo(
    () => data?.pages.flatMap((p) => p.data) ?? [],
    [data],
  );

  const handleSelect = useCallback(
    (id: string) => {
      router.push(`/admin/inbox/${id}`);
    },
    [router],
  );

  return (
    <div className="flex h-full flex-col">
      {/* ── Filters ── */}
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder={t("Buscar mensagem...")}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) =>
            setStatusFilter(v as "all" | "pending" | "open" | "resolved")
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {t(opt.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── List ── */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <CircleNotch size={20} className="animate-spin" aria-label={t("Carregando")} />
          </div>
        )}

        {pedeAcompanhamento && (
          <div className="p-4 text-center" data-testid="caixa-pede-acompanhamento">
            <p className="text-sm font-medium">{t("Abra um acompanhamento para ver as conversas")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Por segurança, as conversas de uma empresa só aparecem enquanto um acompanhamento dela estiver aberto. Abra o acompanhamento na página da empresa e volte aqui.",
              )}
            </p>
            <Link
              href="/admin/tenants"
              className="mt-3 inline-block text-xs font-medium underline underline-offset-2"
            >
              {t("Ir para as empresas")}
            </Link>
          </div>
        )}

        {isError && !pedeAcompanhamento && (
          <p className="p-4 text-center text-xs text-destructive">
            {t("Falha ao carregar conversas.")}
          </p>
        )}

        {!isLoading && !pedeAcompanhamento && rows.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {t("Nenhuma conversa encontrada.")}
          </p>
        )}

        {rows.map((row) => {
          const isSelected = selectedId === row.id;
          const name = contactName(row, t);
          const org = row.organizations;
          const unread = row.unread_count_for_assignee ?? 0;
          const preview = row.last_message_preview?.trim() || t("Sem mensagens");
          const time = relativeTime(row.last_message_at, localeDaData);

          return (
            <button
              key={row.id}
              type="button"
              onClick={() => handleSelect(row.id)}
              className={cn(
                "group flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40",
                isSelected && "bg-accent/60",
              )}
              aria-current={isSelected ? "true" : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">{time}</span>
              </div>

              {org && (
                <div className="flex items-center gap-1">
                  <TenantBadge name={org.display_name} slug={org.slug} size="sm" />
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground">
                  {preview.length > 55 ? `${preview.slice(0, 55)}…` : preview}
                </p>
                {unread > 0 && (
                  <Badge className="h-4 min-w-4 shrink-0 px-1.5 text-2xs">{unread}</Badge>
                )}
              </div>
            </button>
          );
        })}

        {hasNextPage && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            >
              {isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
