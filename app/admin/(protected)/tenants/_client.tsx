"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import { TenantsFilters } from "@/components/admin/tenants/TenantsFilters";
import {
  TenantsTable,
  TenantsTableSkeleton,
} from "@/components/admin/tenants/TenantsTable";
import { useAdminTenants, type AdminTenantsFilters } from "@/hooks/useAdminTenants";
import { useT } from "@/hooks/i18n/useT";
import { useMarcaDaPlataforma } from "@/lib/redesign/plataforma";

export function TenantsClient() {
  const t = useT();
  const rd = useMarcaDaPlataforma();
  const [filters, setFilters] = useState<AdminTenantsFilters>({});

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminTenants(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        data-rd-plataforma={rd("cabecalho")}
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight" data-rd-plataforma={rd("titulo")}>{t("Tenants")}</h1>
          <p className="text-sm text-muted-foreground mt-1" data-rd-plataforma={rd("subtitulo")}>
            {isLoading ? t("Carregando...") : `${total} tenant${total !== 1 ? "s" : ""}${hasNextPage ? "+" : ""}`}
          </p>
        </div>
        <Button asChild size="sm" className="shrink-0" data-rd-plataforma={rd("criar")}>
          <Link href="/admin/tenants/new">
            <Plus size={16} aria-hidden />
            {t("Novo tenant")}
          </Link>
        </Button>
      </div>

      {/* Filters */}
      <TenantsFilters filters={filters} onChange={setFilters} />

      {/* Table */}
      {isLoading ? (
        <TenantsTableSkeleton />
      ) : (
        <TenantsTable
          data={rows}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
