import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { converterRegra, type RegraAntiga } from "@/lib/automacoes/converter-regra";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { BlocosDaConversao } from "./BlocosDaConversao";
import { PublicarConversao } from "./PublicarConversao";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ruleId: string }> };

/**
 * Pré-visualização da conversão de uma regra antiga (lote 5): os blocos que a automação nova teria,
 * como RASCUNHO — nada é gravado até a pessoa publicar. Regra sem equivalente mostra o motivo e
 * o caminho da tela antiga, onde ela continua funcionando.
 */
export default async function ConverterRegraPage({ params }: Props) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  const { ruleId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) notFound();

  const supabase = await createClient();
  const { data: regra } = await supabase
    .from("automation_rules")
    .select(
      "id, name, trigger_event, trigger_config, conditions, actions, is_active, migrated_to_pointer_id",
    )
    .eq("id", ruleId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!regra) notFound();
  if (regra.migrated_to_pointer_id) redirect(`/app/automacoes/${regra.migrated_to_pointer_id}`);

  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId);
  const nomeDaEtapa = new Map((etapas ?? []).map((e) => [e.id as string, e.name as string]));

  const conversao = converterRegra(regra as unknown as RegraAntiga);
  const telaAntiga = `/app/webhooks?tab=rules&regra=${regra.id}`;

  return (
    <div className="flex h-full flex-col gap-6 p-6" data-testid="previa-da-conversao">
      <header className="space-y-1">
        <Link
          href="/app/automacoes"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          {t("Voltar para Automações")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{regra.name}</h1>
        <p className="text-sm text-text-muted">
          {t("Regra antiga")} · {regra.is_active ? t("Ligada") : t("Desligada")}
        </p>
      </header>

      {!conversao.conversivel ? (
        <Card className="space-y-3 p-5" data-testid="regra-nao-conversivel">
          <h2 className="font-medium">
            {t("Regra antiga — continua funcionando; abra na tela antiga.")}
          </h2>
          <p className="text-sm text-text-muted">
            {t("Estas partes ainda não existem nas automações novas:")}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {conversao.naoConvertido.map((n, i) => (
              <li key={i}>{t(n.motivo)}</li>
            ))}
          </ul>
          <Link
            href={telaAntiga}
            className="inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            {t("Abrir na tela antiga")}
          </Link>
        </Card>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            {t("É assim que a regra fica no formato novo. Nada muda até você publicar.")}
          </p>
          <BlocosDaConversao
            nodes={conversao.grafo.nodes}
            etapas={Object.fromEntries(nomeDaEtapa)}
          />
          <PublicarConversao ruleId={regra.id} />
        </>
      )}
    </div>
  );
}
