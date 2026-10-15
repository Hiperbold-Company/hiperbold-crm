import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { configDoAsaas } from "@/lib/billing/asaas/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { pedidoDaAssinatura } from "@/lib/onboarding/pedido-da-assinatura";
import { podeEscolherOutraForma } from "@/lib/onboarding/situacao-do-pedido";
import { planoPreSelecionado } from "@/lib/auth/plano-escolhido";
import { precisaPagarAntesDeConfigurar } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { dadosDaCompraDePlano } from "@/app/app/settings/plano/assinar/_dados";
import { AssinarPlanoPassoAPasso } from "@/app/app/settings/plano/assinar/_passo-a-passo";
import { AguardandoPagamento } from "./_aguardando";

export const dynamic = "force-dynamic";

/**
 * "Seu plano": o cliente novo escolhe o plano e paga ANTES de configurar o CRM (decisão do dono do
 * produto, 15/10/2026). É a MESMA compra de `/app/settings/plano/assinar` (Pix, cartão, parcelas e
 * cupom): o formulário e a leitura do catálogo são os de lá, sem regra de preço repetida aqui.
 *
 * O passo não se pula. Ele só existe enquanto `precisaPagarAntesDeConfigurar` é verdadeiro — a
 * mesma noção do layout de /app; quando deixa de ser (contrato ativo, plano liberado pelo admin,
 * compra desligada), esta página manda para o roteador do wizard, que escolhe o próximo passo.
 */
export default async function PlanoPage({
  searchParams,
}: {
  searchParams: Promise<{ plano?: string | string[] }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const admin = createAdminClient();
  if (!(await precisaPagarAntesDeConfigurar(admin, activeOrg.orgId))) redirect("/onboarding");

  const cabecalho = (
    <header>
      <h2 className="text-2xl font-semibold tracking-tight">{t("Escolha seu plano")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("Escolha o plano e conclua o pagamento. Assim que ele for confirmado, você entra no CRM.")}
      </p>
    </header>
  );

  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return (
      <div className="space-y-6">
        {cabecalho}
        <p className="text-sm text-muted-foreground">
          {t("Peça a um administrador desta organização para escolher o plano e concluir o pagamento.")}
        </p>
      </div>
    );
  }

  // `precisaPagarAntesDeConfigurar` já provou que a compra está ligada, então a configuração é válida.
  const { ambiente } = configDoAsaas();

  const pedido = await pedidoDaAssinatura(admin, activeOrg.orgId, ambiente);
  // Pedido aberto que não vai andar (inconclusivo sem fatura, ou parado há mais de 24 h): o formulário volta,
  // com um aviso. Repetir a mesma opção retoma ESTE pedido; o banco não admite um segundo aberto.
  const pedidoParado = pedido ? podeEscolherOutraForma(pedido) : false;
  if (pedido && !pedidoParado) {
    return (
      <div className="space-y-6">
        {cabecalho}
        <AguardandoPagamento
          pedidoId={pedido.id}
          statusInicial={pedido.status}
          metodo={pedido.metodo}
          urlDaCobranca={pedido.invoiceUrl}
        />
      </div>
    );
  }

  const dados = await dadosDaCompraDePlano(admin, activeOrg.orgId, ambiente, logger);

  // Pré-seleção: `?plano=` e, na falta, o que o cadastro guardou. `getUser()` valida o JWT no servidor.
  const { plano: planoDaUrl } = await searchParams;
  const { data: sessao } = await (await createClient()).auth.getUser();
  const planoInicial = planoPreSelecionado(
    dados.planos.map((p) => p.code),
    [planoDaUrl, sessao.user?.user_metadata?.plano_escolhido],
  );

  return (
    <div className="space-y-6">
      {cabecalho}
      {pedidoParado && (
        <div
          role="status"
          data-testid="plano-pedido-parado"
          className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
        >
          {t(
            "Seu pedido anterior não foi concluído. Escolha de novo a forma de pagamento: se for a mesma opção, retomamos o mesmo pedido, sem cobrar duas vezes.",
          )}
        </div>
      )}
      {dados.leituraFalhou && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {t("Não foi possível carregar os planos à venda agora. Atualize a página.")}
        </div>
      )}
      {!dados.leituraFalhou && dados.planos.length === 0 && (
        <div className="rounded-md border border-border p-6 text-sm text-muted-foreground">
          {t("Nenhum plano ou pacote está à venda no momento.")}
        </div>
      )}
      {dados.planos.length > 0 && (
        <AssinarPlanoPassoAPasso
          planos={dados.planos}
          opcoesDeParcelas={dados.opcoesDeParcelas}
          taxaMensalPercentual={dados.taxaMensalPercentual}
          precisaPagador={dados.precisaPagador}
          planoAtualCode={dados.planoAtualCode}
          pixDisponivel={dados.pixDisponivel}
          planoInicial={planoInicial}
          depoisDePago={{ href: "/onboarding" }}
        />
      )}
    </div>
  );
}
