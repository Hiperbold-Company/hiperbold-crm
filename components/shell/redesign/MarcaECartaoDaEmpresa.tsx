"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { AvatarDaEmpresa } from "@/components/shell/AvatarDaEmpresa";
import { useTrocaDeOrganizacao } from "@/components/shell/TenantSwitcher";
import { navegarPeloItemDoMenu } from "@/components/shell/UserMenu";
import { useAbaixoDeMd } from "@/hooks/useAbaixoDeMd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoPapel } from "@/lib/auth/types";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { Check } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A marca no alto do menu. A RESOLUÇÃO é a mesma de `SidebarContent`
 * (`components/shell/Sidebar.tsx`, onde o porquê de cada linha está escrito):
 * nome e logo da organização acima da instalação, `||` para o logo, e o
 * desenho do produto só quando ninguém pôs marca própria.
 */
export function MarcaDoMenu({ aberto }: { aberto: boolean }) {
  const { activeOrg } = useAuth();
  const brand = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? brand.name;
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;
  const logoEscuro =
    activeOrg?.marca?.logoDarkUrl !== undefined
      ? activeOrg.marca.logoDarkUrl
      : activeOrg?.marca?.logoUrl
        ? null
        : brand.logoDarkUrl;
  const marcaDoProduto = marcaEhADoProduto({ name: nome, logoUrl: logo ?? null });

  if (marcaDoProduto) {
    return aberto ? (
      <LogotipoDoProduto nome={nome} className="h-6 w-auto" />
    ) : (
      <SimboloDoProduto nome={nome} className="h-8 w-8" />
    );
  }
  if ((logo || logoEscuro) && aberto) {
    return (
      <span className={cn("min-w-0 rounded-md", !logoEscuro && "dark:bg-white dark:px-2 dark:py-1")}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- URL de quem hospeda; ver Sidebar.tsx
          <img
            src={logo}
            alt={nome}
            className={cn("h-7 w-auto max-w-[min(10rem,100%)] object-contain", logoEscuro && "dark:hidden")}
          />
        ) : null}
        {logoEscuro ? (
          // eslint-disable-next-line @next/next/no-img-element -- idem
          <img
            src={logoEscuro}
            alt={nome}
            className="hidden h-7 w-auto max-w-[min(10rem,100%)] object-contain dark:block"
          />
        ) : null}
      </span>
    );
  }
  return aberto ? (
    <span className="min-w-0 truncate text-sm font-bold" title={nome}>
      {nome}
    </span>
  ) : (
    <span
      aria-label={nome}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-base font-bold text-accent-foreground"
    >
      {[...nome][0]?.toUpperCase() ?? brand.initial}
    </span>
  );
}

/**
 * O cartão da empresa atual, que é também o seletor de empresa.
 *
 * A troca é a de `TenantSwitcher` (`useTrocaDeOrganizacao`): mesma transição,
 * mesma ação, mesma recarga. Sem o que trocar (uma empresa só, sem ser dono do
 * servidor), o cartão só informa — o seletor antigo some nesse caso.
 */
export function CartaoDaEmpresa({
  aberto,
  largura = "desktop",
}: {
  aberto: boolean;
  /**
   * Em que largura este cartão é o que se VÊ: o do menu lateral (desktop) e o
   * do "Mais" do celular ficam os dois no DOM, e só o visível na largura atual
   * leva os `data-testid` de sempre — senão haveria dois `tenant-switcher`.
   */
  largura?: "desktop" | "celular";
}) {
  const t = useT();
  const router = useRouter();
  const visivel = useAbaixoDeMd() === (largura === "celular");
  const { user, active, isPending, switchTo, podeTrocar } = useTrocaDeOrganizacao();
  const ativa = user.organizations.find((o) => o.organization_id === active?.orgId);
  const nome = active?.name ?? ativa?.organization_name ?? "";
  const papel = active?.role ? t(rotuloDoPapel(active.role)) : "";

  const miolo = (
    <>
      <AvatarDaEmpresa nome={nome} logoUrl={ativa?.logo_url ?? null} tamanho={32} />
      {aberto && (
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate text-sm font-semibold">{nome}</span>
          {papel && <span className="truncate text-xs text-muted-foreground">{papel}</span>}
        </span>
      )}
    </>
  );
  const caixa = cn(
    "flex w-full items-center gap-2.5 rounded-xl",
    aberto ? "border border-border bg-surface-elevated p-2" : "justify-center py-1",
  );

  if (!podeTrocar) {
    return (
      <div className={caixa} title={nome}>
        {miolo}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isPending || !!user.support}
          className={cn(
            caixa,
            "transition-colors hover:border-border-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          )}
          aria-label={`${t("Organização")}: ${active?.name ?? t("Selecionar org")}`}
          title={user.support ? t("Saia do acompanhamento para trocar de organização") : nome}
          data-testid={visivel ? "tenant-switcher" : undefined}
        >
          {miolo}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {t("Suas empresas")}
        </DropdownMenuLabel>
        {user.organizations.map((org) => (
          <DropdownMenuItem
            key={org.organization_id}
            data-testid={visivel ? `tenant-switcher-item-${org.organization_id}` : undefined}
            onClick={() => {
              void switchTo(org.organization_id);
            }}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <AvatarDaEmpresa nome={org.organization_name} logoUrl={org.logo_url ?? null} />
              <span className="truncate">{org.organization_name}</span>
            </span>
            {active?.orgId === org.organization_id && (
              <Check size={16} className="text-accent" aria-label={t("Atual")} />
            )}
          </DropdownMenuItem>
        ))}
        {user.is_platform_admin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              asChild
              onClick={(event) => navegarPeloItemDoMenu(event, router, "/admin/tenants")}
            >
              <Link href="/admin/tenants">{t("Gerenciar organizações")}</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
