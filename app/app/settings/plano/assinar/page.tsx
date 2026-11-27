/**
 * `/app/settings/plano/assinar`: fase F5, Tarefa 20 (`hiperbold/planos/
 * fase-F5-tarefas.md`): assinar um plano ou comprar um pacote de tokens
 * pelo PRÓPRIO CLIENTE, atrás das duas chaves da decisão 18.
 *
 * ─── Só o papel `admin` (N41) ───────────────────────────────────────────────
 *
 * Mesma régua de `app/actions/settings/compraDoPlano.ts` (autorização real,
 * que roda de novo a cada chamada): aqui é só o que decide o CONTEÚDO da
 * tela. Quem não é admin da organização vê "peça a um administrador", nunca
 * o formulário de compra.
 *
 * ─── As duas chaves da decisão 18, checadas ANTES de ler o catálogo ────────
 *
 * `ASAAS_ENABLED` e `billing_settings.compra_pelo_cliente` precisam estar
 * ligadas ao mesmo tempo; sem isso a tela nem lê `billing_plans`/
 * `billing_token_pacotes`, e mostra a frase fixa do briefing.
 *
 * ─── Só o que tem preço e está à venda (restrição fixa 3 da fase) ──────────
 *
 * `planosParaVenda` (`lib/billing/asaas/leitura.ts`) já lê todo plano ATIVO;
 * esta página filtra por `forSale && priceMonthlyCents > 0` antes de
 * mostrar. Pacote segue a mesma régua em `./_dados.ts` (`ativo` e
 * `preco_cents` preenchido). Hoje nenhum plano tem `for_sale` e nenhum
 * pacote tem preço (restrição fixa 6): a tela tem que ficar honesta e bonita
 * vazia também.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { compraLigada, configDoAsaas, ErroConfiguracaoAsaas } from "@/lib/billing/asaas/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { dadosDaCompraDePlano } from "./_dados";
import { AssinarOuComprarClient } from "./_client";

export const metadata = { title: "Assinar" };
export const dynamic = "force-dynamic";

export default async function AssinarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Assinar ou comprar")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Peça a um administrador desta organização para assinar um plano ou comprar um pacote de tokens.")}
        </p>
      </div>
    );
  }

  const admin = createAdminClient();

  let habilitado = false;
  let erroConfiguracao = false;
  try {
    const config = configDoAsaas();
    habilitado = config.habilitado;
  } catch (err) {
    erroConfiguracao = true;
    logger.error("[assinar] configuração do Asaas inválida", {
      erro: err instanceof ErroConfiguracaoAsaas ? err.message : String(err),
    });
  }

  const ligada = await compraLigada(admin, habilitado && !erroConfiguracao);

  if (!ligada) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Assinar ou comprar")}</h1>
        <div className="rounded-md border border-warning/30 bg-warning-bg p-4 text-sm text-warning-fg">
          {t("A compra pela tela ainda não está disponível. Fale com o suporte.")}
        </div>
      </div>
    );
  }

  // O formulário do pagador já chega com o e-mail e o celular de quem está logado. `getUser()` valida o JWT.
  const { data: sessao } = await (await createClient()).auth.getUser();
  const dados = await dadosDaCompraDePlano(admin, activeOrg.orgId, logger, {
    email: user.email,
    celular: sessao.user?.phone ?? null,
  });

  return (
    <AssinarOuComprarClient
      opcoesDeParcelas={dados.opcoesDeParcelas}
      taxaMensalPercentual={dados.taxaMensalPercentual}
      planos={dados.planos}
      pacotes={dados.pacotes}
      pagadorInicial={dados.pagadorInicial}
      leituraFalhou={dados.leituraFalhou}
      planoAtualCode={dados.planoAtualCode}
      pixDisponivel={dados.pixDisponivel}
    />
  );
}
