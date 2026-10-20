import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { MembrosDaAgencia, type MembroDaAgenciaLinha } from "@/components/admin/tenants/MembrosDaAgencia";

import { TenantOverviewClient } from "./_client";

interface TenantDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const { id } = await params;
  const { platformAdmin } = await requirePlatformAdmin();

  // Leitura cross-tenant de propósito (cliente de serviço, sempre filtrada pela organização da URL).
  const admin = createAdminClient();
  const { data: vinculos } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", id)
    .eq("membro_da_agencia", true)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });

  const membros: MembroDaAgenciaLinha[] = await Promise.all(
    (vinculos ?? []).map(async (v) => {
      const { data } = await admin.auth.admin.getUserById(v.user_id);
      const u = data?.user;
      return {
        userId: v.user_id,
        email: u?.email ?? null,
        nome: (u?.user_metadata?.full_name as string | undefined) ?? null,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <TenantOverviewClient id={id} />
      <MembrosDaAgencia organizationId={id} membros={membros} podeEscrever={platformAdmin.scope === "full"} />
    </div>
  );
}
