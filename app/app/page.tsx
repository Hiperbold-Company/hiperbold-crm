import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { homeDaInterface } from "@/lib/navigation/interface";
import { CAMINHO_DA_ASSINATURA, organizacaoSemPlano } from "@/lib/billing/assinatura/sem-plano";
import { carregarDadosDosPrimeirosPassos } from "@/lib/inicio/carregar";
import { CAMINHO_DO_INICIO, entrarNoInicio, papelRecebeOInicio } from "@/lib/inicio/entrada";
import { primeirosPassos } from "@/lib/inicio/primeiros-passos";
import { compraPeloClienteDisponivel } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";
export default async function AppHome() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  const admin = createAdminClient();
  // D-094: a entrada de /app também vale na navegação interna, em que o layout não roda de novo.
  if (org && !user.support && (await organizacaoSemPlano(admin, org.orgId))) {
    redirect(CAMINHO_DA_ASSINATURA);
  }
  // Hiperbold (15/10/2026): com a compra pelo cliente ligada, pago o plano, o CRM abre no Início
  // enquanto faltar um passo OBRIGATÓRIO (`lib/inicio/entrada.ts`). Só o admin da empresa passa por
  // aqui (a leitura só roda para quem pode receber o Início); compra desligada: nada muda.
  if (org && !user.support && papelRecebeOInicio(org.role) && (await compraPeloClienteDisponivel(admin))) {
    const dados = await carregarDadosDosPrimeirosPassos(admin, org.orgId, user.id, true);
    const { contagem } = primeirosPassos(dados);
    if (
      entrarNoInicio({
        compraLigada: dados.compraLigada,
        papel: org.role,
        suporte: false,
        obrigatoriosFaltando: contagem.obrigatoriosFaltando,
      })
    ) {
      redirect(CAMINHO_DO_INICIO);
    }
  }
  redirect(
    homeDaInterface(
      org?.interface_settings,
      user.is_platform_admin && !user.support,
      org?.role ?? null,
    ),
  );
}
