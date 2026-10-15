import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ConnectNuvemshopClient } from "./_client";
import { traduzir } from "@/lib/i18n/dicionario";
import { exigirPlanoPagoParaSeguir } from "@/lib/onboarding/contexto";

export const dynamic = "force-dynamic";

export default async function ConnectNuvemshopPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  // Hiperbold: o cliente novo paga antes de configurar; a URL direta volta para o passo "Plano".
  await exigirPlanoPagoParaSeguir(activeOrg.orgId);
  const idioma = user.idioma;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">{traduzir("Conectar Nuvemshop", idioma)}</h2>
        <p className="text-sm text-muted-foreground">
          {traduzir("Importe pedidos, clientes e produtos da sua loja Nuvemshop.", idioma)}
        </p>
      </header>
      <ConnectNuvemshopClient />
    </div>
  );
}
