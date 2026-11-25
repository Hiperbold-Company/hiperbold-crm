"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useSalvarLinhasDoCartao } from "@/hooks/kanban/useLinhasDoCartao";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import {
  CAMPOS_DO_CARTAO,
  LINHAS_PADRAO,
  MAXIMO_DE_LINHAS,
  type CampoDoCartao,
  type LeadDoCartao,
} from "@/lib/kanban/linhas-do-cartao";
import { CaretDown, CaretUp, PencilSimple } from "@/lib/ui/icons";

import { ContatoNoCard } from "./ContatoNoCard";

/** Uma vaga do modal: um campo ou nenhum. As vagas vazias não vão para o card. */
type Vaga = CampoDoCartao | null;

const NENHUM = "__nenhum__";

function vagasDe(linhas: readonly CampoDoCartao[]): Vaga[] {
  const vagas: Vaga[] = [...linhas];
  while (vagas.length < MAXIMO_DE_LINHAS) vagas.push(null);
  return vagas.slice(0, MAXIMO_DE_LINHAS);
}

/** O cartão de exemplo da prévia: um valor para cada um dos 10 campos. */
function leadDeExemplo(t: (texto: string) => string): Partial<LeadDoCartao> {
  return {
    contact_phone: "+5511987654321",
    contact_email: "ana.souza@exemplo.com.br",
    contact_empresa: t("Clínica Bem Viver"),
    contact_cargo: t("Gerente de compras"),
    source: "site",
    tags: [t("Cliente VIP")],
    contact_tags: [t("Indicação")],
    conversation_tags: [t("Orçamento")],
    conversa: { id: "exemplo", preview: t("Oi! Queria saber o valor da consulta."), last_message_at: null, unread: 0 },
    custom_fields: { utm_source: "instagram", utm_medium: "social", utm_campaign: "turmas-janeiro" },
  };
}

/**
 * O botão "Editar cartão" da barra do quadro. Só existe para gerente e
 * administrador (a rota confere o mesmo papel no servidor). O diálogo só monta
 * quando aberto: ele carrega a gravação, e a página não precisa dela fechada.
 */
export function BotaoEditarCartao({
  role,
  pipelineId,
  linhas,
}: {
  role: Role | null | undefined;
  pipelineId: string;
  /** As linhas em vigor (`linhasDoCartao(settings)`). */
  linhas: readonly CampoDoCartao[];
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  if (!roleAtLeast(role, "manager")) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="editar-cartao"
        title={t("Escolher o que o cartão deste funil mostra")}
        onClick={() => setAberto(true)}
      >
        <PencilSimple size={14} className="mr-1.5" aria-hidden />
        {t("Editar cartão")}
      </Button>
      {aberto && (
        <EditarCartaoDialog
          pipelineId={pipelineId}
          linhas={linhas}
          onFechar={() => setAberto(false)}
        />
      )}
    </>
  );
}

export function EditarCartaoDialog({
  pipelineId,
  linhas,
  onFechar,
}: {
  pipelineId: string;
  linhas: readonly CampoDoCartao[];
  onFechar: () => void;
}) {
  const t = useT();
  const [vagas, setVagas] = useState<Vaga[]>(() => vagasDe(linhas));
  /** "Voltar ao padrão" marcado e nada mexido depois: salvar apaga a chave. */
  const [voltarAoPadrao, setVoltarAoPadrao] = useState(false);
  const salvar = useSalvarLinhasDoCartao(pipelineId);

  const escolhidas = vagas.filter((v): v is CampoDoCartao => v !== null);

  function mudar(proximas: Vaga[]) {
    setVagas(proximas);
    setVoltarAoPadrao(false);
  }

  function trocar(i: number, valor: string) {
    const proximas = [...vagas];
    proximas[i] = valor === NENHUM ? null : (valor as CampoDoCartao);
    mudar(proximas);
  }

  function mover(i: number, delta: -1 | 1) {
    const j = i + delta;
    if (j < 0 || j >= vagas.length) return;
    const proximas = [...vagas];
    [proximas[i], proximas[j]] = [proximas[j]!, proximas[i]!];
    mudar(proximas);
  }

  async function aoSalvar() {
    try {
      await salvar.mutateAsync(voltarAoPadrao ? null : escolhidas);
      toast.success(t("Cartão atualizado."));
      onFechar();
    } catch {
      toast.error(t("Não foi possível salvar o cartão. Tente de novo."));
    }
  }

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onFechar()}>
      <DialogContent className="max-w-2xl" data-testid="editar-cartao-dialog">
        <DialogHeader>
          <DialogTitle>{t("Editar cartão")}</DialogTitle>
          <DialogDescription>
            {t("Escolha até 5 linhas para o cartão deste funil. Vale para toda a equipe. Linha sem valor não aparece no cartão.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
          <ol className="space-y-2">
            {vagas.map((vaga, i) => (
              <li key={i} className="flex items-center gap-2" data-testid={`linha-${i + 1}`}>
                <span className="w-4 shrink-0 text-xs tabular-nums text-text-muted">{i + 1}</span>
                <Select value={vaga ?? NENHUM} onValueChange={(v) => trocar(i, v)}>
                  <SelectTrigger className="flex-1" aria-label={`${t("Linha")} ${i + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NENHUM}>{t("Nenhum")}</SelectItem>
                    {CAMPOS_DO_CARTAO.map((campo) => (
                      <SelectItem
                        key={campo}
                        value={campo}
                        // Um campo só cabe numa linha: o que já está noutra fica indisponível.
                        disabled={campo !== vaga && escolhidas.includes(campo)}
                      >
                        <NomeDoCampo campo={campo} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t("Subir")} ${t("linha")} ${i + 1}`}
                  disabled={i === 0}
                  onClick={() => mover(i, -1)}
                >
                  <CaretUp size={14} aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t("Descer")} ${t("linha")} ${i + 1}`}
                  disabled={i === vagas.length - 1}
                  onClick={() => mover(i, 1)}
                >
                  <CaretDown size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ol>

          <div>
            <p className="mb-1.5 text-xs font-medium text-text-muted">{t("Prévia")}</p>
            <div
              className="rounded-md border border-border bg-surface py-2.5 pl-3 pr-3 shadow-xs"
              data-testid="previa-do-cartao"
            >
              <p className="text-sm font-medium leading-5 text-text">{t("Ana Souza")}</p>
              <p className="mt-1 text-xs font-medium tabular-nums text-text">R$ 1.200</p>
              <ContatoNoCard lead={leadDeExemplo(t)} linhas={escolhidas} />
              {escolhidas.length === 0 && (
                <p className="mt-1 text-2xs italic text-text-muted">{t("Nenhuma linha de contato.")}</p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            data-testid="editar-cartao-padrao"
            onClick={() => {
              setVagas(vagasDe(LINHAS_PADRAO));
              setVoltarAoPadrao(true);
            }}
          >
            {t("Voltar ao padrão")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onFechar} disabled={salvar.isPending}>
              {t("Cancelar")}
            </Button>
            <Button
              type="button"
              data-testid="editar-cartao-salvar"
              onClick={() => void aoSalvar()}
              disabled={salvar.isPending}
            >
              {t("Salvar")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** O nome do campo no Select. As UTM ficam com o nome técnico, com a explicação no `title`. */
function NomeDoCampo({ campo }: { campo: CampoDoCartao }) {
  const t = useT();
  switch (campo) {
    case "ultima_mensagem":
      return <>{t("Última mensagem")}</>;
    case "telefone":
      return <>{t("Telefone")}</>;
    case "email":
      return <>{t("E-mail")}</>;
    case "empresa":
      return <>{t("Empresa")}</>;
    case "cargo":
      return <>{t("Cargo")}</>;
    case "origem":
      return <>{t("Origem")}</>;
    case "etiquetas":
      return <>{t("Etiquetas")}</>;
    case "utm_source":
      return <span title={t("utm_source: de onde veio o clique (ex.: google, instagram)")}>utm_source</span>;
    case "utm_medium":
      return <span title={t("utm_medium: o tipo de mídia (ex.: cpc, email, social)")}>utm_medium</span>;
    case "utm_campaign":
      return <span title={t("utm_campaign: o nome da campanha")}>utm_campaign</span>;
  }
}
