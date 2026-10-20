"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SuspendDialog } from "./SuspendDialog";
import { ReactivateDialog } from "./ReactivateDialog";
import { ExcluirOrganizacaoDialog } from "./ExcluirOrganizacaoDialog";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantActionsProps {
  organizationId: string;
  status: "active" | "suspended" | "redacted";
  displayName: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantActions({
  organizationId,
  status,
  displayName,
  slug,
}: TenantActionsProps) {
  const t = useT();
  const router = useRouter();
  const [excluirOpen, setExcluirOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const canSuspend = status === "active";
  const isSuspended = status === "suspended";
  const isRedacted = status === "redacted";

  return (
    <>
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t("Ações")}
        </h2>

        {/* Impersonate (S-11.07) */}
        <ImpersonateButton
          organizationId={organizationId}
          displayName={displayName}
          disabled={isRedacted}
          disabledReason={
            isRedacted ? t("Tenant redigido — ação não disponível") : undefined
          }
        />

        {/* Suspend */}
        {canSuspend && (
          <Button
            className="w-full"
            variant="destructive"
            onClick={() => setSuspendOpen(true)}
            aria-label={t("Suspender tenant")}
          >
            {t("Suspender tenant")}
          </Button>
        )}

        {/* Reactivate */}
        {isSuspended && (
          <Button
            className="w-full"
            variant="outline"
            onClick={() => setReactivateOpen(true)}
            aria-label={t("Reativar tenant")}
          >
            {t("Reativar tenant")}
          </Button>
        )}

        {/* Excluir: só depois de suspender. Em tenant ativo fica desabilitado com a dica. */}
        {!isRedacted && (
          <div className="space-y-1">
            <Button
              className="w-full"
              variant="destructive"
              disabled={!isSuspended}
              onClick={() => setExcluirOpen(true)}
              data-testid="excluir-organizacao"
              title={!isSuspended ? t("Suspenda antes de excluir") : undefined}
            >
              {t("Excluir organização")}
            </Button>
            {!isSuspended && (
              <p className="text-xs text-muted-foreground text-center">{t("Suspenda antes de excluir")}</p>
            )}
          </div>
        )}

        {isRedacted && (
          <p className="text-xs text-muted-foreground text-center py-2">
            {t("Tenant redigido — ações de gestão não disponíveis.")}
          </p>
        )}
      </div>

      <SuspendDialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        organizationId={organizationId}
      />

      <ReactivateDialog
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        organizationId={organizationId}
      />

      {isSuspended && (
        <ExcluirOrganizacaoDialog
          open={excluirOpen}
          onClose={() => setExcluirOpen(false)}
          organizacao={{ id: organizationId, slug, displayName }}
          onExcluida={() => router.push("/admin/tenants")}
        />
      )}
    </>
  );
}
