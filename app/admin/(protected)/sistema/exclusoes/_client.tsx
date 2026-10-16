"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  cancelarExclusao,
  excluirAgora,
  programarExclusao,
  type ExclusaoListada,
  type OrganizacaoParaProgramar,
} from "@/app/actions/admin/exclusoes";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

/**
 * A lista das exclusões programadas e o formulário de programar à mão (migration 0959). A frase de erro vem
 * pronta da ação e vai direto ao toast, sem passar por `t()`. "Excluir agora" só habilita o botão final quando o
 * nome digitado é IGUAL ao da organização; a ação confere de novo no servidor.
 */
export function ListaDeExclusoes({ exclusoes }: { exclusoes: ExclusaoListada[] }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();

  if (exclusoes.length === 0) {
    return <p className="text-sm text-text-muted">{t("Nenhuma exclusão programada.")}</p>;
  }
  const data = (iso: string) => new Date(iso).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" });
  const rotuloDoMotivo = {
    cancelada: t("Assinatura cancelada"),
    suspensa: t("Suspensa por falta de pagamento"),
    manual: t("Programada à mão"),
  } as const;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Empresa")}</TableHead>
          <TableHead>{t("Motivo")}</TableHead>
          <TableHead>{t("Fim da assinatura")}</TableHead>
          <TableHead>{t("Exclusão em")}</TableHead>
          <TableHead>{t("Avisos enviados")}</TableHead>
          <TableHead>{t("Situação")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {exclusoes.map((e) => (
          <TableRow key={e.organizationId} data-testid={`exclusao-${e.organizationId}`}>
            <TableCell className="font-medium">{e.empresa}</TableCell>
            <TableCell>{rotuloDoMotivo[e.motivo]}</TableCell>
            <TableCell>{e.fimDaAssinaturaEm ? data(e.fimDaAssinaturaEm) : "-"}</TableCell>
            <TableCell>{data(e.excluirEm)}</TableCell>
            <TableCell>
              {[e.aviso30DiasEm ? t("30 dias") : null, e.aviso7DiasEm ? t("7 dias") : null].filter(Boolean).join(", ") || "-"}
            </TableCell>
            <TableCell>
              <Badge variant={e.estado === "programada" ? "warning" : "neutral"}>
                {e.estado === "programada" ? t("Programada") : t("Cancelada")}
              </Badge>
            </TableCell>
            <TableCell>
              <AcoesDaExclusao exclusao={e} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AcoesDaExclusao({ exclusao }: { exclusao: ExclusaoListada }) {
  const t = useT();
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [excluindo, setExcluindo] = useState(false);
  const [nome, setNome] = useState("");

  function cancelar() {
    iniciar(async () => {
      const r = await cancelarExclusao({ organizationId: exclusao.organizationId });
      if (!r.ok) return void toast.error(r.error);
      toast.success(t("Exclusão cancelada."));
      router.refresh();
    });
  }

  function excluir() {
    iniciar(async () => {
      const r = await excluirAgora({ organizationId: exclusao.organizationId, nomeDigitado: nome, confirmar: true });
      if (!r.ok) return void toast.error(r.error);
      toast.success(t("Organização excluída."));
      setExcluindo(false);
      setNome("");
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {exclusao.estado === "programada" && (
          <Button
            size="sm"
            variant="outline"
            disabled={pendente}
            data-testid={`cancelar-exclusao-${exclusao.organizationId}`}
            onClick={cancelar}
          >
            {t("Cancelar exclusão")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={pendente}
          data-testid={`excluir-agora-${exclusao.organizationId}`}
          onClick={() => setExcluindo(true)}
        >
          {t("Excluir agora")}
        </Button>
      </div>
      <DialogoDeExclusao
        aberto={excluindo}
        empresa={exclusao.empresa}
        nome={nome}
        aoDigitar={setNome}
        pendente={pendente}
        aoFechar={() => {
          setExcluindo(false);
          setNome("");
        }}
        aoConfirmar={excluir}
        idDoTeste={exclusao.organizationId}
      />
    </>
  );
}

function DialogoDeExclusao(props: {
  aberto: boolean;
  empresa: string;
  nome: string;
  aoDigitar: (v: string) => void;
  pendente: boolean;
  aoFechar: () => void;
  aoConfirmar: () => void;
  idDoTeste: string;
}) {
  const t = useT();
  const confere = props.nome === props.empresa;
  return (
    <AlertDialog open={props.aberto} onOpenChange={(aberto) => !aberto && props.aoFechar()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir os dados desta organização agora?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Isto apaga conversas, contatos, arquivos, conexões e as contas que pertencem só a esta organização. Não tem volta. Registros fiscais ficam arquivados por 5 anos. Para confirmar, digite o nome da organização exatamente como aparece abaixo.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">{props.empresa}</p>
        <Input
          value={props.nome}
          onChange={(e) => props.aoDigitar(e.target.value)}
          placeholder={t("Digite o nome da organização")}
          data-testid={`nome-da-exclusao-${props.idDoTeste}`}
          autoComplete="off"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.pendente}>{t("Voltar")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={props.pendente || !confere}
            data-testid={`confirmar-exclusao-${props.idDoTeste}`}
            onClick={props.aoConfirmar}
          >
            {t("Excluir definitivamente")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FormularioDeProgramar({ organizacoes }: { organizacoes: OrganizacaoParaProgramar[] }) {
  const t = useT();
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [org, setOrg] = useState("");
  const [dia, setDia] = useState("");

  if (organizacoes.length === 0) {
    return <p className="text-sm text-text-muted">{t("Todas as organizações já estão programadas.")}</p>;
  }

  function programar() {
    iniciar(async () => {
      const r = await programarExclusao({ organizationId: org, data: dia });
      if (!r.ok) return void toast.error(r.error);
      toast.success(t("Exclusão programada."));
      setOrg("");
      setDia("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm">
        <span className="block font-medium">{t("Organização")}</span>
        <select
          className="h-9 min-w-64 rounded-md border border-input bg-background px-3 text-sm"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          data-testid="programar-exclusao-organizacao"
        >
          <option value="">{t("Escolha uma organização")}</option>
          {organizacoes.map((o) => (
            <option key={o.id} value={o.id}>
              {o.empresa}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-sm">
        <span className="block font-medium">{t("Excluir em")}</span>
        <Input type="date" value={dia} onChange={(e) => setDia(e.target.value)} data-testid="programar-exclusao-data" />
      </label>
      <Button disabled={pendente || !org || !dia} onClick={programar} data-testid="programar-exclusao">
        {t("Programar exclusão")}
      </Button>
    </div>
  );
}
