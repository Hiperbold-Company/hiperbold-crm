"use client";

import { signOut } from "@/app/actions/auth/signOut";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * A saída da conta no cabeçalho do wizard. Sem ela, quem entrou por convite numa organização que ainda não
 * pagou (não é administrador, não pode escolher plano) ficava numa tela sem nenhuma porta: o layout de `/app`,
 * onde mora o menu do usuário, não aparece no onboarding. Usa a mesma ação de saída do menu.
 */
export function SairDoOnboarding() {
  const t = useT();
  return (
    <form action={signOut}>
      <Button type="submit" variant="ghost" size="sm" data-testid="sair-da-conta">
        {t("Sair")}
      </Button>
    </form>
  );
}
