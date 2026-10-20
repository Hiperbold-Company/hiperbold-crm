"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  cancelarExclusao,
  excluirAgora,
  programarExclusao,
  situacaoDaExclusaoDaOrganizacao,
  type SituacaoDaExclusaoDaOrganizacao,
} from "@/app/actions/admin/exclusoes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { dataBr } from "@/lib/retencao/exclusao-de-organizacao/datas";

/**
 * "Excluir organização" do painel de tenants (`/admin/tenants`). Só se chega aqui com o tenant SUSPENSO.
 *
 * Não reinventa a exclusão: programar, cancelar e excluir agora são as ações da tela Sistema › Exclusões
 * (migration 0959). A frase de erro vem pronta da ação e vai direto ao toast. "Excluir agora" só habilita o
 * botão com o slug IGUAL ao da organização; a ação confere de novo no servidor, e lá exige a suspensão.
 */
export interface OrganizacaoParaExcluir {
  id: string;
  slug: string;
  displayName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  organizacao: OrganizacaoParaExcluir;
  /** Chamado depois que a organização foi excluída (a página de detalhe volta para a lista). */
  onExcluida?: () => void;
}

/** `aaaa-mm-dd` -> `dd/mm/aaaa`, sem passar por Date (nada de fuso). */
function dataDoDia(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}/${m}/${a}`;
}

export function ExcluirOrganizacaoDialog({ open, onClose, organizacao, onExcluida }: Props) {
  const [pendente, setPendente] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(aberto) => !aberto && !pendente && onClose()}>
      <DialogContent className="max-w-xl" data-testid="excluir-organizacao-dialog">
        {/* O conteúdo só existe com o modal aberto: cada abertura começa do zero (slug vazio, situação lida de novo). */}
        <Conteudo
          onClose={onClose}
          organizacao={organizacao}
          onExcluida={onExcluida}
          pendente={pendente}
          setPendente={setPendente}
        />
      </DialogContent>
    </Dialog>
  );
}

function Conteudo({
  onClose,
  organizacao,
  onExcluida,
  pendente,
  setPendente,
}: Omit<Props, "open"> & { pendente: boolean; setPendente: (v: boolean) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [situacao, setSituacao] = useState<SituacaoDaExclusaoDaOrganizacao | null>(null);
  const [erroDeLeitura, setErroDeLeitura] = useState<string | null>(null);
  const [dia, setDia] = useState("");
  const [slug, setSlug] = useState("");

  function carregar() {
    void situacaoDaExclusaoDaOrganizacao({ organizationId: organizacao.id }).then((r) => {
      if (!r.ok) return setErroDeLeitura(r.error);
      setErroDeLeitura(null);
      setSituacao(r);
      setDia(r.dataPadrao);
    });
  }

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lê a situação uma vez por abertura
  }, [organizacao.id]);

  async function executar(
    acao: () => Promise<{ ok: true } | { ok: false; error: string }>,
    sucesso: () => void,
  ) {
    setPendente(true);
    try {
      const r = await acao();
      if (!r.ok) return void toast.error(r.error);
      sucesso();
    } finally {
      setPendente(false);
    }
  }

  function programar() {
    void executar(
      () => programarExclusao({ organizationId: organizacao.id, data: dia }),
      () => {
        toast.success(t("Exclusão programada."));
        carregar();
      },
    );
  }

  function cancelarProgramacao() {
    void executar(
      () => cancelarExclusao({ organizationId: organizacao.id }),
      () => {
        toast.success(t("Exclusão cancelada."));
        carregar();
      },
    );
  }

  function excluir() {
    void executar(
      () => excluirAgora({ organizationId: organizacao.id, slugDigitado: slug, confirmar: true }),
      () => {
        toast.success(t("Organização excluída."));
        void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
        setSlug("");
        onClose();
        onExcluida?.();
      },
    );
  }

  const confere = slug === organizacao.slug;
  const programada = situacao?.programada ?? null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Excluir organização")}</DialogTitle>
        <DialogDescription>
          {organizacao.displayName} ({organizacao.slug})
        </DialogDescription>
      </DialogHeader>

      {erroDeLeitura && (
        <p className="text-sm text-destructive" role="alert">
          {erroDeLeitura}
        </p>
      )}

      {programada && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning-fg"
          data-testid="exclusao-ja-programada"
        >
          <span>
            {t("Exclusão já programada para")}{" "}
            <strong>{dataBr(new Date(programada.excluirEm))}</strong>.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pendente}
            onClick={cancelarProgramacao}
            data-testid="cancelar-exclusao-programada"
          >
            {t("Cancelar exclusão")}
          </Button>
        </div>
      )}

      <section className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">{t("Programar exclusão")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Os dados ficam guardados até a data escolhida e a organização é excluída sozinha nesse dia. Você pode cancelar antes.",
          )}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="excluir-org-data">{t("Excluir em")}</Label>
            <Input
              id="excluir-org-data"
              type="date"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
              data-testid="excluir-organizacao-data"
            />
          </div>
          <Button
            variant="outline"
            disabled={pendente || !situacao || !dia}
            onClick={programar}
            data-testid="programar-exclusao-da-organizacao"
          >
            {programada ? t("Reprogramar exclusão") : t("Programar exclusão")}
          </Button>
        </div>
        {situacao && dia && (
          <p className="text-xs text-muted-foreground" data-testid="data-que-vai-valer">
            {t("Vai valer")}: <strong>{dataDoDia(dia)}</strong>.{" "}
            {dia === situacao.dataPadrao
              ? t("Esta é a data da regra padrão: suspensão mais {n} dias de guarda.").replace(
                  "{n}",
                  String(situacao.diasDeGuarda),
                )
              : t("Data escolhida por você.")}
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-destructive/40 p-4">
        <h3 className="text-sm font-semibold text-destructive">{t("Excluir agora")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Apaga na hora os contatos, negócios, conversas, mídias, conexões e as contas de usuário que pertencem só a esta organização. Os registros fiscais ficam arquivados por 5 anos e a auditoria é mantida. Não tem volta.",
          )}
        </p>
        <div className="space-y-1">
          <Label htmlFor="excluir-org-slug">
            {t("Para confirmar, digite o identificador (slug)")}:{" "}
            <span className="font-mono">{organizacao.slug}</span>
          </Label>
          <Input
            id="excluir-org-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={organizacao.slug}
            autoComplete="off"
            data-testid="excluir-organizacao-slug"
          />
        </div>
        <Button
          variant="destructive"
          disabled={pendente || !confere}
          onClick={excluir}
          data-testid="excluir-organizacao-agora"
        >
          {t("Excluir agora")}
        </Button>
      </section>
    </>
  );
}
