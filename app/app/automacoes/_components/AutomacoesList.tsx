"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlowStatusBadge } from "@/app/app/ai/followups/_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "@/app/app/ai/followups/_components/DeleteFollowupFlowButton";
import {
  useCreateFollowupFlow,
  useFollowupFlows,
  type FollowupFlowPointerRow,
} from "@/hooks/followup/useFollowupFlows";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { FlowArrow, Plus } from "@/lib/ui/icons";

export function AutomacoesList({ initialData }: { initialData: FollowupFlowPointerRow[] }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const { data } = useFollowupFlows({ initialData, surface: "automacao" });
  const [aberto, setAberto] = useState(false);
  const lista = data ?? [];

  const botaoNova = (
    <Button onClick={() => setAberto(true)} data-testid="nova-automacao" className="w-full sm:w-auto">
      <Plus size={14} aria-hidden className="mr-2" /> {t("Nova automação")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {lista.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">{t("Nenhuma automação ainda")}</h2>
          <p className="max-w-sm text-sm text-text-muted">
            {t(
              "Exemplo: quando um lead chegar pelo Facebook, criar o negócio no funil de vendas, pôr a tag Facebook e definir o responsável por rodízio.",
            )}
          </p>
          {botaoNova}
        </Card>
      ) : (
        <>
          <div className="flex justify-end">{botaoNova}</div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="lista-de-automacoes">
            {lista.map((a) => (
              <li key={a.id}>
                <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-accent-400">
                  <Link href={`/app/automacoes/${a.id}`} className="flex flex-1 flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="min-w-0 flex-1 truncate font-medium" title={a.name}>
                        {a.name}
                      </h3>
                      <FlowStatusBadge status={a.status} />
                    </div>
                    <p className="text-xs text-text-muted">
                      {t("Atualizada em")}{" "}
                      {new Date(a.updated_at).toLocaleDateString(idioma, {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      })}
                    </p>
                  </Link>
                  <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                    <Link href={`/app/automacoes/${a.id}/execucoes`} className="text-xs text-accent-600 hover:underline">
                      {t("Ver execuções")}
                    </Link>
                    <DeleteFollowupFlowButton flowId={a.id} flowName={a.name} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      <NovaAutomacaoDialog aberto={aberto} onAberto={setAberto} />
    </div>
  );
}

function NovaAutomacaoDialog({ aberto, onAberto }: { aberto: boolean; onAberto: (v: boolean) => void }) {
  const t = useT();
  const router = useRouter();
  const criar = useCreateFollowupFlow();
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    criar.mutate(
      { name: nome.trim(), surface: "automacao" },
      {
        // A automação nasce com Início (manual) → Fim: abre direto no editor.
        onSuccess: (fluxo) => router.push(`/app/automacoes/${fluxo.id}`),
        onError: (err: unknown) =>
          setErro(err instanceof Error && err.message ? t(err.message) : t("Não consegui criar a automação. Tente de novo.")),
      },
    );
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        if (!v) {
          setNome("");
          setErro(null);
        }
        onAberto(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Nova automação")}</DialogTitle>
          <DialogDescription>
            {t("Nasce como rascunho. No editor você escolhe o gatilho e monta os passos.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={enviar} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="automacao-nome">{t("Nome")}</Label>
            <Input
              id="automacao-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex: Novo lead do Facebook")}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          {erro && (
            <p role="alert" className="text-sm text-error-fg">
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onAberto(false)} disabled={criar.isPending}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={criar.isPending || nome.trim().length === 0} data-testid="criar-automacao">
              {criar.isPending ? t("Criando…") : t("Criar automação")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
