import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { redesignLigado } from "@/lib/redesign/chave";
import { marcaDaAgenda } from "@/lib/redesign/agenda";
import { RiskRadarList } from "./_components/RiskRadarList";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Radar" };

export default async function RadarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const rd = marcaDaAgenda(redesignLigado());

  return (
    <div className="flex h-full flex-col gap-6 md:p-6" data-rd-agenda={rd("radar-tela")}>
      <header data-rd-agenda={rd("radar-cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Radar de risco")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Demandas abertas que esfriaram e precisam de você. Se o assistente já agendou um retorno, aparece como “em voo”; sem próximo passo, é risco de perder o cliente.",
          )}
        </p>
      </header>
      <RiskRadarList />
    </div>
  );
}
