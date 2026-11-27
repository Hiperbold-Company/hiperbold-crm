"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useRedesignDoTenant } from "@/hooks/useRedesignDoTenant";

interface Props {
  organizationId: string;
  /** Estado lido no servidor: `settings.redesign.ligado === true`. */
  ligado: boolean;
  /** Só o admin da plataforma de escopo `full` altera; a rota confere de novo no servidor. */
  podeEscrever: boolean;
}

/**
 * "Novo visual" na página da organização, no painel da plataforma: liga o
 * redesign só para ESTA empresa (fase 1 do lançamento). Quem lê a chave é
 * `redesignNaRequisicao()` em `lib/redesign/chave.ts`.
 */
export function CartaoDoNovoVisual({ organizationId, ligado, podeEscrever }: Props) {
  const t = useT();
  const router = useRouter();
  const [atual, setAtual] = useState(ligado);
  const mutacao = useRedesignDoTenant((novo) => {
    setAtual(novo);
    router.refresh();
  });
  const idDoSwitch = `novo-visual-${organizationId}`;

  return (
    <Card data-testid="novo-visual">
      <CardHeader>
        <CardTitle className="text-base">{t("Novo visual")}</CardTitle>
        <CardDescription>
          {t("Liga o novo visual só para esta empresa. As outras continuam no visual atual.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Switch
          id={idDoSwitch}
          checked={atual}
          disabled={!podeEscrever || mutacao.isPending}
          onCheckedChange={(valor) => mutacao.mutate({ id: organizationId, ligado: valor })}
        />
        <Label htmlFor={idDoSwitch} className="text-sm">
          {atual ? t("Ligado") : t("Desligado")}
        </Label>
      </CardContent>
    </Card>
  );
}
