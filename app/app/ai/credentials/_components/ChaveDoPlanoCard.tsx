"use client";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DA_OPCAO_DO_PLANO } from "@/lib/ai/agents/opcoes-de-provedor";

/**
 * O cartão FIXO da chave do plano: a chave da instalação (OpenRouter), que o Hiperbold CRM já traz
 * incluída. Não é uma linha de `ai_provider_credentials`: por isso não tem Modelos, "Em uso por",
 * editar, atualizar nem excluir — e nunca mostra dígito algum da chave (a tela nem recebe o valor).
 */
export function ChaveDoPlanoCard() {
  const t = useT();
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="chave-do-plano">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t(ROTULO_DA_OPCAO_DO_PLANO)}</h2>
        <Badge variant="default">{t("Incluída no seu plano")}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t("O uso desconta do limite de tokens do seu plano.")}</p>
    </Card>
  );
}
