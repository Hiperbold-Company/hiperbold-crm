"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DotsThree } from "@/lib/ui/icons";
import { useAbaixoDeMd } from "@/hooks/useAbaixoDeMd";
import { useT } from "@/hooks/i18n/useT";

export interface AcaoDoMenu {
  rotulo: string;
  icone?: ComponentType<{ size?: number; weight?: "bold"; "aria-hidden"?: boolean }>;
  onSelect?: () => void;
  href?: string;
  desativada?: boolean;
}

interface Props {
  /** Os botões do computador, exatamente como eram. Só aparecem de md para cima. */
  children: ReactNode;
  /** As mesmas ações como lista, para o menu "⋯" do celular. */
  acoes: AcaoDoMenu[];
}

/**
 * md+: os `children` como estão. Abaixo de md: um botão "⋯" com o menu `acoes`.
 * Os dois conjuntos são declarados porque um botão do desktop pode ser um menu
 * (ex.: Exportar) que não se aninha dentro de outro menu sem virar duas linhas.
 */
export function AcoesNoCelular({ children, acoes }: Props) {
  const t = useT();
  const celular = useAbaixoDeMd();

  if (!celular) return <>{children}</>;
  if (acoes.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t("Mais ações")}>
          <DotsThree size={20} weight="bold" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {acoes.map((a) => {
          const Icone = a.icone;
          const conteudo = (
            <>
              {Icone ? <Icone size={16} weight="bold" aria-hidden /> : null}
              <span>{a.rotulo}</span>
            </>
          );
          return a.href ? (
            <DropdownMenuItem key={a.rotulo} asChild disabled={a.desativada}>
              <Link href={a.href} className="flex items-center gap-2">
                {conteudo}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={a.rotulo} onSelect={a.onSelect} disabled={a.desativada} className="flex items-center gap-2">
              {conteudo}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
