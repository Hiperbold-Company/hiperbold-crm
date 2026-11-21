"use client";
import Link from "next/link";
import { useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useOrganizationTransition } from "./OrganizationTransitionProvider";
import { CaretDown } from "@/lib/ui/icons";
import { AvatarDaEmpresa } from "./AvatarDaEmpresa";
import { useUser, useActiveOrg } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

/**
 * A troca de organização em si, exportada para a moldura do redesign usar o
 * MESMO caminho (transição, ação, recarga em `/app/inbox`).
 */
export function useTrocaDeOrganizacao() {
  const t = useT();
  const user = useUser();
  const active = useActiveOrg();
  const transition = useOrganizationTransition();
  const [isPending, setPending] = useState(false);
  const switchTo = async (orgId: string) => {
    if (orgId === active?.orgId) return;
    flushSync(() => { setPending(true); transition.begin(t("Carregando organização…")); });
    try {
      const result = await setActiveOrg(orgId);
      if (!result.ok) throw new Error(result.error);
      // Novo documento elimina QueryClient, subscriptions e respostas em voo.
      window.location.assign("/app/inbox");
    } catch {
      transition.cancel();
      setPending(false);
      toast.error(t("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente."));
    }
  };
  const podeTrocar = !(user.organizations.length <= 1 && !user.is_platform_admin);
  return { user, active, isPending, switchTo, podeTrocar };
}

export function TenantSwitcher() {
  const t = useT();
  const { user, active, isPending, switchTo, podeTrocar } = useTrocaDeOrganizacao();

  if (!podeTrocar) return null;

  // A logo da empresa ativa sai da MESMA lista do menu (`logo_url` de cada
  // vínculo), e não de `active.marca`: aquela é a marca do produto e só existe
  // com o módulo `marca_por_organizacao` ligado.
  const ativa = user.organizations.find((o) => o.organization_id === active?.orgId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/*
          ⚠️ NO CELULAR ESTE BOTÃO É SÓ O ÍCONE, e isso não é economia de estilo:
          é o que faz o cabeçalho caber.

          Medido na tela, numa instalação real em 360px: com o nome escrito, o
          botão ocupava 153px e o cabeçalho tinha 14 sobreposições, a pior de
          96px — o nome da organização por baixo do campo de busca, e a busca por
          cima do sino. Hambúrguer + nome + busca + sino + avatar não cabem em
          360px, e o bloco do meio é `flex-1 justify-center` entre dois
          `shrink-0`: quando falta espaço ele transborda por cima dos vizinhos em
          vez de encolher.

          Só o ícone: 40px, e as sobreposições vão a zero. O nome completo
          continua a UM TOQUE, dentro do menu que este botão já abre — e
          continua no `aria-label`, para quem usa leitor de tela.

          `min-w-0` sozinho NÃO resolve (medido): ele deixa o flex comprimir o
          texto, mas a 18px visíveis o nome vira "M…", e as colisões de 13px com
          a busca continuam. O espaço é que não existe.
        */}
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending || !!user.support}
          // `px-2.5` com o avatar de 20px mantém o botão em 40px no celular, o
          // mesmo teto medido do ícone que ele substitui (16px + `px-3`).
          className="gap-2 px-2.5"
          aria-label={`${t("Organização")}: ${active?.name ?? t("Selecionar org")}`}
          title={user.support ? "Saia do acompanhamento para trocar de organização" : undefined}
          data-testid="tenant-switcher"
        >
          <AvatarDaEmpresa
            nome={active?.name ?? ativa?.organization_name ?? ""}
            logoUrl={ativa?.logo_url ?? null}
            tamanho={20}
          />
          <span className="hidden max-w-[160px] truncate md:inline">
            {active?.name ?? "Selecionar org"}
          </span>
          <CaretDown size={12} aria-hidden className="hidden md:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {user.organizations.map((org) => (
          <DropdownMenuItem
            key={org.organization_id}
            data-testid={`tenant-switcher-item-${org.organization_id}`}
            onClick={() => { void switchTo(org.organization_id); }}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <AvatarDaEmpresa nome={org.organization_name} logoUrl={org.logo_url ?? null} />
              <span className="truncate">{org.organization_name}</span>
            </span>
            {active?.orgId === org.organization_id && <span className="text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
        {user.is_platform_admin && <DropdownMenuItem asChild>
          <Link href="/admin/tenants">{t("Gerenciar organizações")}</Link>
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
