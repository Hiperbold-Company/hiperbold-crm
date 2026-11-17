"use client";

import { useCallback, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requestExtensionApi } from "@/components/extensions/api-client";
import { useT } from "@/hooks/i18n/useT";
import { randomId } from "@/lib/random-id";

interface ModuloCatalogo {
  slug: string;
  nome: string;
  descricao: string;
}

interface ModuloInstalado {
  modulo: string;
  estado: "ativo" | "suspenso" | "desligado";
  instalado_em: string;
  reaplicado_em: string | null;
  motivo_suspensao: string | null;
}

interface ListagemDeModulos {
  disponiveis: readonly ModuloCatalogo[];
  instalados: readonly ModuloInstalado[];
}

/**
 * Instalar um módulo NA INSTÂNCIA (ADR-0002, D3). Sem catálogo remoto, sem versão para
 * escolher — é o botão mais simples que existe: o slug já vem fixo do catálogo declarado no
 * servidor, e o único estado possível depois de instalar é "ativo" ou, numa atualização
 * futura que falhe, "suspenso" (D6) — e, desde a migration 1016, "desligado": o administrador da
 * instalação desliga e religa o módulo sem apagar dado nenhum (só o estado muda). Por isso este componente não repete a máquina de estados
 * de `ExtensionsManager` (catálogo remoto, versões, reverter) — nada disso existe para módulo.
 */
export function ModulosManager({ inicial }: { inicial: ListagemDeModulos }) {
  const t = useT();
  const [estado, setEstado] = useState(inicial);
  const [instalando, setInstalando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const instalar = useCallback(async (slug: string) => {
    setInstalando(slug);
    setErro(null);
    const idempotencyKey = randomId();
    const resultado = await requestExtensionApi<{ operationId: string; appliedNow: boolean }>(
      "/api/v1/modulos/instalar",
      {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ modulo: slug }),
      },
    );
    if (!resultado.ok) {
      setErro(resultado.error.message);
      setInstalando(null);
      return;
    }
    const recarregado = await requestExtensionApi<ListagemDeModulos>("/api/v1/modulos");
    if (recarregado.ok) setEstado(recarregado.data);
    setInstalando(null);
  }, []);

  const [aDesligar, setADesligar] = useState<ModuloCatalogo | null>(null);

  /** Desliga ou religa. `estadoVisto` vai junto: se outra sessão mudou o módulo, o servidor
   * responde 409 e nada muda (concorrência otimista); a lista é recarregada de qualquer jeito. */
  const definirEstado = useCallback(
    async (slug: string, ligar: boolean, estadoVisto: ModuloInstalado["estado"]) => {
      setInstalando(slug);
      setErro(null);
      const resultado = await requestExtensionApi<{ operationId: string; appliedNow: boolean }>(
        "/api/v1/modulos/estado",
        {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify({ modulo: slug, ligado: ligar, estado_visto: estadoVisto }),
        },
      );
      if (!resultado.ok) setErro(resultado.error.message);
      const recarregado = await requestExtensionApi<ListagemDeModulos>("/api/v1/modulos");
      if (recarregado.ok) setEstado(recarregado.data);
      setInstalando(null);
    },
    [],
  );

  const instaladoPorSlug = new Map(estado.instalados.map((m) => [m.modulo, m]));

  return (
    <div className="space-y-4">
      {erro ? (
        <p role="alert" className="text-sm text-destructive" data-testid="modulos-erro">
          {erro}
        </p>
      ) : null}
      {estado.disponiveis.map((modulo) => {
        const instalado = instaladoPorSlug.get(modulo.slug);
        return (
          <Card key={modulo.slug} className="p-5" data-testid={`modulo-${modulo.slug}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">{t(modulo.nome)}</h3>
                  {instalado ? (
                    <Badge
                      variant={
                        instalado.estado === "ativo"
                          ? "success"
                          : instalado.estado === "desligado"
                            ? "neutral"
                            : "destructive"
                      }
                      data-testid={`estado-${modulo.slug}`}
                    >
                      {instalado.estado === "ativo"
                        ? t("Instalado")
                        : instalado.estado === "desligado"
                          ? t("Desligado")
                          : t("Suspenso")}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 max-w-xl text-sm text-text-muted">{t(modulo.descricao)}</p>
                {instalado?.motivo_suspensao ? (
                  <p className="mt-1 text-xs text-destructive">
                    {t("Suspenso")}: {instalado.motivo_suspensao}
                  </p>
                ) : null}
              </div>
              {instalado?.estado === "ativo" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setADesligar(modulo)}
                  disabled={instalando === modulo.slug}
                  data-testid={`desligar-${modulo.slug}`}
                >
                  {instalando === modulo.slug ? t("Desligando…") : t("Desligar")}
                </Button>
              ) : instalado?.estado === "desligado" ? (
                <Button
                  size="sm"
                  onClick={() => void definirEstado(modulo.slug, true, "desligado")}
                  disabled={instalando === modulo.slug}
                  data-testid={`religar-${modulo.slug}`}
                >
                  {instalando === modulo.slug ? t("Ligando…") : t("Ligar de novo")}
                </Button>
              ) : instalado ? null : (
                <Button
                  size="sm"
                  onClick={() => void instalar(modulo.slug)}
                  disabled={instalando === modulo.slug}
                  data-testid={`instalar-${modulo.slug}`}
                >
                  {instalando === modulo.slug ? t("Instalando…") : t("Instalar")}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      <AlertDialog open={aDesligar !== null} onOpenChange={(aberto) => (aberto ? null : setADesligar(null))}>
        <AlertDialogContent data-testid="confirmar-desligar-modulo">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Desligar {nome}?").replace("{nome}", aDesligar ? t(aDesligar.nome) : "")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Os menus e telas somem para todas as organizações. Os dados ficam guardados e voltam ao religar.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-desligar"
              onClick={() => {
                const alvo = aDesligar;
                setADesligar(null);
                if (alvo) void definirEstado(alvo.slug, false, "ativo");
              }}
            >
              {t("Desligar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
