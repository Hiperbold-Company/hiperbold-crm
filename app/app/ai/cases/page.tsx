import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDaIa } from "@/lib/redesign/ia";
import { CaseList } from "./_components/CaseList";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // GET/POST de /api/v1/ai/cases exigem role agent+ (requireRole("agent")) —
  // abaixo disso a rota nem devolve dado, então a tela inteira gate aqui.
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.agent) redirect("/app");
  const idioma = user.idioma;
  const rd = marcaDaIa(await redesignNaRequisicao());

  return (
    <div className="flex h-[calc(100dvh-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] min-h-0 flex-col sm:p-6" data-rd-ia={rd("pagina")}>
      <CaseList heading={
        <header data-rd-ia={rd("cabecalho")}>
          <h1 className="text-2xl font-semibold tracking-tight" data-rd-ia={rd("titulo")}>{traduzir("Casos", idioma)}</h1>
          <p className="text-sm text-muted-foreground" data-rd-ia={rd("descricao")}>
            {traduzir(
              "Quando a IA trava em algo que só um humano resolve, ela abre um caso aqui — e continua conversando com o cliente enquanto espera sua resposta.",
              idioma,
            )}
          </p>
        </header>
      } />
    </div>
  );
}
