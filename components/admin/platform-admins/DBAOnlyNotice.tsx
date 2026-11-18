"use client";
import Link from "next/link";
import { Info } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

export function DBAOnlyNotice() {
  const t = useT();
  return (
    <div
      role="note"
      className="flex gap-3 rounded-lg border border-info/30 bg-info-bg p-4 text-info-fg"
    >
      <Info size={20} className="mt-0.5 shrink-0 text-info-fg" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-semibold">
          {t("Gerenciamento de Platform Admins é restrito ao DBA")}
        </p>
        <p className="text-sm leading-relaxed text-info-fg">
          {t("Conforme Spec 01 §3.4 T-04: adição, remoção ou alteração de")}{" "}
          <code className="rounded-md bg-info-bg px-1 font-mono text-xs">
            platform_admins
          </code>{" "}
          {t("é feita exclusivamente via SQL pelo DBA, com nota explicativa em")}{" "}
          <code className="rounded-md bg-info-bg px-1 font-mono text-xs">
            api_audit_log
          </code>
          {t(
            ". Esta página é informativa e read-only — nenhum botão de modificação está disponível por design.",
          )}
        </p>
        <p className="pt-1">
          <Link
            href="/runbook/platform-admin-management.md"
            className="text-xs font-medium text-info-fg underline underline-offset-2 hover:text-info-fg"
          >
            {t("Ver runbook →")}
          </Link>
        </p>
      </div>
    </div>
  );
}
