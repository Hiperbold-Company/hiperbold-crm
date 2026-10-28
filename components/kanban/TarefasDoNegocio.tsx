"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { Button } from "@/components/ui/button";
import { useFusoDaOrganizacao, usePermission, useUser } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTasks } from "@/hooks/tasks/useTasks";
import { formataDataNoFuso } from "@/lib/kanban/datas-do-lead";
import { estaAtrasada, type NovaTarefa, type Tarefa } from "@/lib/tarefas/tipos";
import { Plus } from "@/lib/ui/icons";

/**
 * As tarefas do negócio, dentro do painel lateral do quadro: as abertas, com
 * prazo e um clique para marcar como feita, e o botão "Criar tarefa".
 *
 * Reaproveita tudo o que a tela de Tarefas já tem: a rota (`/api/v1/tasks`), o
 * hook (`useTasks`, filtrado pelo negócio) e o formulário, no modo curto (o que
 * fazer, detalhes, dia, horário e responsável). A tarefa nasce presa ao negócio
 * e ao contato dele; a rota grava `task_created` na linha do tempo, e concluir
 * grava `task_completed` (`lib/tarefas/atividade.ts`).
 *
 * O responsável vem marcado com quem cria — o caso de todo dia é "eu me lembro
 * de ligar" — e pode ser trocado por outra pessoa da equipe. Quando vencer, o
 * aviso vai a quem criou e ao responsável (migration 0980).
 */
export function TarefasDoNegocio({
  leadId,
  contactId,
}: {
  leadId: string;
  contactId: string | null;
}) {
  const t = useT();
  const usuario = useUser();
  const fuso = useFusoDaOrganizacao();
  const idioma = useTagDeIdioma();
  const podeCriar = usePermission("task.create");
  const { tarefas, carregando, criarTarefa, alternarConcluida } = useTasks({
    lead_id: leadId,
    aberto: true,
  });
  const { data: membros } = useAssignableMembers(podeCriar);
  const [aberto, setAberto] = useState(false);
  const [abertura, setAbertura] = useState(0);
  const [concluindo, setConcluindo] = useState<string | null>(null);

  const responsaveis = useMemo(() => {
    const lista = (membros ?? []).map((m) => ({ id: m.user_id, nome: m.full_name ?? t("Sem nome") }));
    // Quem cria sempre aparece, mesmo fora da lista de atribuíveis (o admin da
    // plataforma, por exemplo): o padrão do campo é ele.
    if (!lista.some((m) => m.id === usuario.id)) {
      lista.unshift({ id: usuario.id, nome: usuario.full_name ?? usuario.email ?? t("Eu") });
    }
    return lista;
  }, [membros, usuario.id, usuario.full_name, usuario.email, t]);

  async function criar(entrada: NovaTarefa) {
    await criarTarefa({ ...entrada, lead_id: leadId, contact_id: contactId });
    toast.success(t("Tarefa criada"));
  }

  async function concluir(tarefa: Tarefa) {
    setConcluindo(tarefa.id);
    try {
      await alternarConcluida(tarefa);
      toast.success(t("Tarefa concluída"));
    } catch (falha) {
      toast.error(falha instanceof Error ? falha.message : t("Não foi possível salvar a tarefa."));
    } finally {
      setConcluindo(null);
    }
  }

  return (
    <section className="border-b border-border py-3" data-testid="tarefas-do-negocio">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Tarefas")}</h3>
        {podeCriar && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setAbertura((n) => n + 1);
              setAberto(true);
            }}
          >
            <Plus size={12} weight="bold" className="mr-1" aria-hidden />
            {t("Criar tarefa")}
          </Button>
        )}
      </div>

      {carregando ? (
        <p className="text-xs text-text-muted">{t("Carregando…")}</p>
      ) : tarefas.length === 0 ? (
        <p className="text-xs text-text-muted">{t("Nenhuma tarefa em aberto neste negócio.")}</p>
      ) : (
        <ul className="space-y-1.5">
          {tarefas.map((tarefa) => {
            const atrasada = estaAtrasada(tarefa);
            return (
              <li
                key={tarefa.id}
                data-testid="tarefa-do-negocio"
                className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-label={`${t("Marcar como feita")}: ${tarefa.title}`}
                  checked={false}
                  disabled={!podeCriar || concluindo === tarefa.id}
                  onChange={() => void concluir(tarefa)}
                />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-text">{tarefa.title}</p>
                  {tarefa.due_date ? (
                    <p className={atrasada ? "text-[11px] text-error-fg" : "text-[11px] text-text-muted"}>
                      {formataDataNoFuso(tarefa.due_date, fuso, idioma, true)}
                      {atrasada ? ` · ${t("Atrasada")}` : ""}
                    </p>
                  ) : (
                    <p className="text-[11px] text-text-muted">{t("Sem prazo")}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {podeCriar && (
        <FormularioDeTarefa
          key={abertura}
          aberto={aberto}
          aoMudarAbertura={setAberto}
          aoSalvar={criar}
          leadId={leadId}
          contactId={contactId}
          responsaveis={responsaveis}
          responsavelPadrao={usuario.id}
          compacto
        />
      )}
    </section>
  );
}
