"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { salvarPermissoesPorPerfil } from "@/app/actions/settings/salvarPermissoesPorPerfil";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoPapel } from "@/lib/auth/types";
import {
  CAPACIDADES,
  CATEGORIAS_DE_PERMISSAO,
  PAPEIS_CONFIGURAVEIS,
  SO_ADMINISTRADOR,
  motivoDaTrava,
  type ChaveDePermissao,
  type PapelConfiguravel,
} from "@/lib/permissoes/catalogo";
import {
  permissoesPadrao,
  resolverPermissoes,
  type PermissoesResolvidas,
} from "@/lib/permissoes/resolver";
import { Lock, ShieldCheck } from "@/lib/ui/icons";

interface Props {
  /** Só o administrador edita; o gerente vê o quadro em modo leitura. */
  podeEditar: boolean;
}

function mesmoMapa(a: PermissoesResolvidas, b: PermissoesResolvidas): boolean {
  return CAPACIDADES.every((c) => {
    const x = a[c.chave];
    const y = b[c.chave];
    return x.length === y.length && x.every((p) => y.includes(p));
  });
}

/**
 * Configurações › Equipe › Permissões. Uma linha por capacidade do catálogo
 * (`lib/permissoes/catalogo.ts`), uma coluna por perfil. A tela só desenha e
 * envia o conjunto desejado: quem valida é a action, e quem barra é a rota.
 */
export function PermissoesPorPerfilClient({ podeEditar }: Props) {
  const t = useT();
  const router = useRouter();
  const activeOrg = useActiveOrg();
  const salvo = useMemo(() => activeOrg?.permissoes ?? permissoesPadrao(), [activeOrg?.permissoes]);
  const [rascunho, setRascunho] = useState<PermissoesResolvidas>(salvo);
  const [salvando, iniciar] = useTransition();

  const mudou = !mesmoMapa(rascunho, salvo);
  const noPadrao = mesmoMapa(rascunho, permissoesPadrao());

  function alternar(chave: ChaveDePermissao, papel: PapelConfiguravel, ligado: boolean) {
    setRascunho((atual) => {
      const conjunto = new Set(atual[chave]);
      if (ligado) conjunto.add(papel);
      else conjunto.delete(papel);
      return resolverPermissoes({ ...atual, [chave]: [...conjunto] });
    });
  }

  function salvar() {
    iniciar(async () => {
      const r = await salvarPermissoesPorPerfil(rascunho);
      if (!r.ok) {
        toast.error(
          r.error === "mfa_required"
            ? t(
                "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.",
              )
            : r.error === "forbidden_role"
              ? t("Só o administrador muda as permissões.")
              : t("Não consegui salvar as permissões agora. Tente de novo."),
        );
        return;
      }
      setRascunho(r.permissoes);
      toast.success(t("Permissões salvas."));
      router.refresh();
    });
  }

  return (
    <TooltipProvider delayDuration={150}>
      <section className="flex flex-col gap-6" data-testid="permissoes-por-perfil">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{t("Permissões por perfil")}</h2>
            <p className="text-sm text-muted-foreground">
              {t(
                "Escolha o que cada perfil pode fazer nesta organização. Vale para todas as pessoas daquele perfil.",
              )}
            </p>
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              <ShieldCheck size={14} weight="bold" aria-hidden />
              {t("Administrador sempre pode tudo.")}
            </p>
          </div>
          {podeEditar ? (
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                disabled={salvando || noPadrao}
                onClick={() => setRascunho(permissoesPadrao())}
              >
                {t("Restaurar padrão")}
              </Button>
              <Button disabled={salvando || !mudou} onClick={salvar}>
                {salvando ? t("Salvando…") : t("Salvar")}
              </Button>
            </div>
          ) : (
            <p className="shrink-0 text-xs text-muted-foreground">
              {t("Só o administrador muda as permissões.")}
            </p>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th scope="col" className="px-4 py-2.5 font-medium text-muted-foreground">
                  {t("O que a pessoa pode fazer")}
                </th>
                {PAPEIS_CONFIGURAVEIS.map((papel) => (
                  <th key={papel} scope="col" className="w-28 px-2 py-2.5 text-center font-medium">
                    {t(rotuloDoPapel(papel))}
                  </th>
                ))}
              </tr>
            </thead>
            {CATEGORIAS_DE_PERMISSAO.map((categoria) => (
              <tbody key={categoria}>
                <tr className="border-b border-border">
                  <th
                    colSpan={1 + PAPEIS_CONFIGURAVEIS.length}
                    scope="colgroup"
                    className="bg-background px-4 pt-4 pb-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {t(categoria)}
                  </th>
                </tr>
                {CAPACIDADES.filter((c) => c.categoria === categoria).map((c) => (
                  <tr
                    key={c.chave}
                    className="border-b border-border last:border-b-0"
                    data-capacidade={c.chave}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{t(c.rotulo)}</div>
                      <div className="text-xs text-muted-foreground">{t(c.descricao)}</div>
                    </td>
                    {PAPEIS_CONFIGURAVEIS.map((papel) => {
                      const liberavel = (c.liberavel as readonly string[]).includes(papel);
                      if (!liberavel) {
                        const motivo = t(motivoDaTrava(c.chave, papel));
                        return (
                          <td key={papel} className="px-2 py-3 text-center">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  tabIndex={0}
                                  aria-label={motivo}
                                  data-trava={papel}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground"
                                >
                                  <Lock size={14} weight="bold" aria-hidden />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{motivo}</TooltipContent>
                            </Tooltip>
                          </td>
                        );
                      }
                      return (
                        <td key={papel} className="px-2 py-3 text-center">
                          <Switch
                            checked={rascunho[c.chave].includes(papel)}
                            disabled={!podeEditar || salvando}
                            onCheckedChange={(v) => alternar(c.chave, papel, v)}
                            aria-label={`${t(c.rotulo)} — ${t(rotuloDoPapel(papel))}`}
                            data-papel={papel}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Lock size={14} weight="bold" aria-hidden />
            {t("Só administrador")}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {t(
              "Estas áreas mudam quem entra, o que custa dinheiro ou o que responde à lei. Ficam com o administrador.",
            )}
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {SO_ADMINISTRADOR.map((item) => (
              <li key={item.rotulo} className="text-sm">
                <span className="font-medium">{t(item.rotulo)}</span>
                <span className="block text-xs text-muted-foreground">{t(item.descricao)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </TooltipProvider>
  );
}
