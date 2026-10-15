import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { proximoPasso } from "@/lib/onboarding/passos";
import { contextoDoOnboardingComLeitura } from "@/lib/onboarding/contexto";
import { destinoDoRoteador, destinoSeJaConcluido } from "@/lib/onboarding/destino";
import { concluirOnboarding } from "@/lib/onboarding/concluir";
import { compraPeloClienteDisponivel } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * O roteador do wizard. A ORDEM não mora mais aqui: mora em
 * `lib/onboarding/passos.ts`, junto com os rótulos e o resumo final — eram três
 * listas independentes que discordavam, e a divergência aparecia como um passo
 * "Loja" fantasma no indicador de toda instalação pelo kit.
 */
export default async function OnboardingIndex() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Sem organização o onboarding não tem o que mostrar — mas mandar para
  // `/login` fechava o círculo: quem entrasse de novo voltaria para cá. A saída
  // é a tela que CRIA a organização que falta.
  if (!activeOrg) redirect("/get-started");

  // Conta de suporte só observa: nunca conclui o onboarding de ninguém (o layout a leva ao inbox).
  if (user.support) redirect("/app/inbox");

  const { state, onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) {
    redirect(destinoSeJaConcluido(await compraPeloClienteDisponivel(createAdminClient())));
  }

  const { ctx, leituraFalhou } = await contextoDoOnboardingComLeitura(activeOrg.orgId);

  // Fail-closed para CONCLUIR: se a leitura do contrato falhou, "não falta passo" pode ser só "não
  // consegui ler" — concluir aqui entregaria o CRM a quem talvez não pagou. Mostra o erro e deixa tentar de novo.
  if (leituraFalhou) {
    const t = (texto: string) => traduzir(texto, user.idioma);
    return (
      <div role="alert" className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <p>{t("Não foi possível confirmar a situação do seu plano agora. Tente novamente em instantes.")}</p>
        <a href="/onboarding" className="underline">
          {t("Tentar novamente")}
        </a>
      </div>
    );
  }

  const destino = destinoDoRoteador(proximoPasso(state, ctx), ctx);

  // Caminho "paga primeiro": pago o plano não resta passo nenhum. Conclui a organização aqui (sem a
  // tela "done") e entra no CRM pelo Início. Qualquer membro pode ser o primeiro a chegar aqui depois
  // do pagamento (o webhook confirma sem sessão): a organização vem da sessão, nunca de parâmetro, e
  // não concluir deixaria o layout de /app devolvendo a pessoa para este roteador, em laço.
  if (destino.tipo === "concluir") {
    const r = await concluirOnboarding({ orgId: activeOrg.orgId, userId: user.id });
    if (!r.ok) throw new Error(`não foi possível concluir o onboarding: ${r.detalhe}`);
  }
  redirect(destino.caminho);
}
