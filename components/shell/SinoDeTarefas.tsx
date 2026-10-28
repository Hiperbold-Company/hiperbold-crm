"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveOrg, useFusoDaOrganizacao } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useTarefasVencidasParaMim } from "@/hooks/tasks/useTarefasVencidasParaMim";
import { formataDataNoFuso } from "@/lib/kanban/datas-do-lead";
import { entregarAviso } from "@/lib/notifications/deliver";
import { avisosNovos, chaveDoAviso, destinoDaTarefa } from "@/lib/tarefas/aviso-de-vencimento";
import type { TarefaComNegocio } from "@/lib/tarefas/tipos";
import { ListChecks } from "@/lib/ui/icons";

/** O que este navegador já avisou (tarefa + prazo). */
const CHAVE_LOCAL = "tarefas.avisadas.v1";
/** Só vira toast o que venceu há até 24h: o atraso antigo fica na lista. */
const JANELA_DO_TOAST_MS = 24 * 60 * 60 * 1000;
/** Abrir o CRM com muitas vencidas não vira uma pilha de toasts. */
const TOASTS_POR_VEZ = 3;

function lerAvisadas(): Set<string> {
  try {
    const bruto = window.localStorage.getItem(CHAVE_LOCAL);
    const lista = bruto ? (JSON.parse(bruto) as unknown) : [];
    return new Set(Array.isArray(lista) ? lista.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function gravarAvisadas(chaves: Set<string>): void {
  try {
    window.localStorage.setItem(CHAVE_LOCAL, JSON.stringify([...chaves].slice(-300)));
  } catch {
    // sem localStorage o pior caso é avisar de novo na próxima aba
  }
}

function hrefDa(tarefa: TarefaComNegocio): string {
  return destinoDaTarefa(tarefa.lead_id, tarefa.lead?.pipeline_id ?? null);
}

/**
 * O SINO DE TAREFAS (migration 0980): as tarefas de quem está olhando (criou ou
 * é responsável) cujo prazo chegou. Com o CRM aberto, a tarefa que vence vira
 * um aviso (toast e notificação do navegador, categoria `task_due` das
 * preferências); depois fica na lista do sino até alguém concluí-la. Com o CRM
 * fechado, o aviso é o push que o cron `tarefas-vencidas` dispara.
 *
 * Não é a Central de avisos (`AlertsBell`): aquela é da organização inteira, e
 * a tarefa é um combinado de UMA pessoa. Sem tarefa vencida, o sino não aparece.
 */
export function SinoDeTarefas() {
  const org = useActiveOrg();
  const t = useT();
  const fuso = useFusoDaOrganizacao();
  const idioma = useTagDeIdioma();
  const { data } = useTarefasVencidasParaMim(Boolean(org));
  const tarefas = data ?? [];

  useEffect(() => {
    if (!data || data.length === 0) return;
    const avisadas = lerAvisadas();
    const novas = avisosNovos(data, avisadas, new Date(), JANELA_DO_TOAST_MS);
    if (novas.length === 0) return;
    for (const tarefa of novas.slice(0, TOASTS_POR_VEZ)) {
      entregarAviso({
        category: "task_due",
        kind: "task_due",
        title: "Hora da tarefa",
        body: tarefa.title,
        tag: `task-due:${tarefa.id}`,
        href: hrefDa(tarefa),
        actionLabel: tarefa.lead_id ? "Abrir negócio" : "Abrir tarefas",
      });
    }
    for (const tarefa of novas) avisadas.add(chaveDoAviso(tarefa));
    gravarAvisadas(avisadas);
  }, [data]);

  if (tarefas.length === 0) return null;
  const total = tarefas.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("Tarefas vencidas")} — ${total}`}
          data-testid="sino-de-tarefas"
          className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-9 lg:w-9"
        >
          <ListChecks size={18} aria-hidden />
          <span
            data-testid="sino-de-tarefas-contagem"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground"
          >
            {total > 99 ? "99+" : total}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Tarefas vencidas")}
        </p>
        <ul className="max-h-80 overflow-y-auto">
          {tarefas.slice(0, 20).map((tarefa) => (
            <li key={tarefa.id} className="border-b border-border last:border-b-0">
              <Link
                href={hrefDa(tarefa)}
                data-testid="sino-de-tarefas-item"
                className="block px-3 py-2 text-sm hover:bg-muted"
              >
                <span className="block truncate font-medium text-text">{tarefa.title}</span>
                <span className="block truncate text-[11px] text-text-muted">
                  {tarefa.due_date ? formataDataNoFuso(tarefa.due_date, fuso, idioma, true) : ""}
                  {tarefa.lead?.title ? ` · ${tarefa.lead.title}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Link
          href="/app/tasks"
          className="block border-t border-border px-3 py-2 text-center text-xs text-text-muted hover:text-text"
        >
          {t("Ver todas as tarefas")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
