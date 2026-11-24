"use client";
/**
 * TAREFAS › PLANOS — onde o plano nasce, cresce e morre (#1752).
 *
 * ═══ Por que esta tela existe ═══
 *
 * Sem ela, gravar um plano exigia editar `organizations.settings.task_plans`
 * à mão no banco: o motor já lia, mas ninguém numa VPS conseguia CADASTRAR.
 * A tela só fala com a rota `settings/task-plans`, que valida com o mesmo
 * `planosSchema` do motor — o que aparece aqui é exatamente o que
 * `apply_task_plan` vai aplicar, e o que não passa daqui jamais chega ao
 * settings.
 *
 * ═══ O que ela NÃO faz ═══
 *
 * Não aplica o plano a negócio nenhum: aplicar é ação de regra (ou do card do
 * lead, quando ele existir). Aqui se monta a sequência; quem dispara é quem
 * decide o momento — misturar os dois ensinaria o operador a aplicar plano na
 * mão e a confiar na marca de idempotência só metade das vezes.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { ListaPadrao } from "@/components/redesign/ListaPadrao";
import { useRedesign } from "@/lib/redesign/contexto";
import { useMarcaDoInicio } from "@/lib/redesign/inicio";
import { ArrowBendUpLeft } from "@/lib/ui/icons";
import { LIMITES_DO_PLANO } from "@/lib/tarefas/limites-do-plano";
import type { PassoDePlano, PlanoDeTarefas } from "@/lib/tarefas/plano";
import { explicarRecusaDoPlano, frasePrazoDoPasso } from "@/lib/tarefas/recusa-do-plano";
import { PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

const CHAVE_DA_CONSULTA = ["settings", "task-plans"] as const;

function rotuloDaPrioridade(t: (s: string) => string, p: string): string {
  if (p === "low") return t("Baixa");
  if (p === "high") return t("Alta");
  if (p === "urgent") return t("Urgente");
  return t("Média");
}

function novoPlano(): PlanoDeTarefas {
  return { id: randomId(), nome: "", descricao: null, passos: [novoPasso()] };
}

function novoPasso(): PassoDePlano {
  return {
    ordem: 1,
    titulo: "",
    descricao: null,
    vence_em_dias: 1,
    prioridade: "medium",
    atribuir_a: "dono_do_lead",
  };
}

export function PlanosDeTarefa() {
  const t = useT();
  const rd = useMarcaDoInicio();
  const ligado = useRedesign();
  const qc = useQueryClient();
  const [rascunho, setRascunho] = useState<PlanoDeTarefas | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const q = useQuery({
    queryKey: CHAVE_DA_CONSULTA,
    queryFn: async () =>
      (await apiClient.get<{ data: { planos: PlanoDeTarefas[] } }>(
        "/api/v1/settings/task-plans",
      )).data,
  });

  const salvar = useMutation({
    mutationFn: async (planos: PlanoDeTarefas[]) =>
      (
        await apiClient.patch<{ data: { planos: PlanoDeTarefas[] } }>(
          "/api/v1/settings/task-plans",
          { planos },
        )
      ).data,
    onSuccess: () => {
      // Fechar aqui e não em `guardar`: a mutação é assíncrona, e ler
      // `isError` logo após `mutate()` mediria o estado do turno ANTERIOR.
      setErro(null);
      setRascunho(null);
      void qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
    },
    // O 422 diz QUAL campo passou do teto; "Dados inválidos." sozinho não
    // deixava a pessoa saber o que corrigir.
    onError: (e: Error) =>
      setErro((e instanceof ApiError ? explicarRecusaDoPlano(e.details, t) : null) ?? e.message),
  });

  // O PATCH substitui a lista INTEIRA. Sem a lista lida (carregando ou com erro),
  // `[]` fingiria "não há planos" e salvar apagaria os que existem: tudo que
  // grava fica desativado até `q.data` chegar.
  const listaLida = q.data !== undefined;
  const planos = q.data?.planos ?? [];

  function guardar() {
    if (!rascunho || !listaLida) return;
    const nome = rascunho.nome.trim();
    if (!nome) {
      setErro(t("Dê um nome ao plano."));
      return;
    }
    if (rascunho.passos.length === 0) {
      setErro(t("O plano precisa de pelo menos um passo."));
      return;
    }
    if (rascunho.passos.some((p) => !p.titulo.trim())) {
      setErro(t("Escreva o título de todos os passos."));
      return;
    }
    const prazoTorto = rascunho.passos.findIndex(
      (p) =>
        !Number.isInteger(p.vence_em_dias) ||
        p.vence_em_dias < 0 ||
        p.vence_em_dias > LIMITES_DO_PLANO.venceEmDias,
    );
    if (prazoTorto >= 0) {
      setErro(frasePrazoDoPasso(t, prazoTorto + 1));
      return;
    }
    const pronto: PlanoDeTarefas = {
      ...rascunho,
      nome,
      descricao: rascunho.descricao?.trim() ? rascunho.descricao.trim() : null,
      passos: rascunho.passos.map((p, i) => ({ ...p, ordem: i + 1 })),
    };
    const outraVez = planos.some((p) => p.id === pronto.id);
    salvar.mutate(outraVez ? planos.map((p) => (p.id === pronto.id ? pronto : p)) : [...planos, pronto]);
  }

  function excluir(plano: PlanoDeTarefas) {
    if (!listaLida) return;
    salvar.mutate(planos.filter((p) => p.id !== plano.id));
  }

  if (ligado) {
    const totalDePassos = planos.reduce((soma, p) => soma + p.passos.length, 0);
    const comDescricao = planos.filter((p) => p.descricao?.trim()).length;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {erro || rascunho || q.isError ? (
          <div className="space-y-4 px-7 pt-5">
            {erro ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                {erro}
              </p>
            ) : null}
            {q.isError && !listaLida ? (
              <Card role="alert" className="space-y-2 p-4 text-sm">
                <p>
                  {t(
                    "Não foi possível carregar os planos. Para não apagar os que já existem, criar e salvar ficam desativados até a lista carregar.",
                  )}
                </p>
                <Button type="button" variant="outline" onClick={() => void q.refetch()}>
                  {t("Tentar de novo")}
                </Button>
              </Card>
            ) : null}
            {rascunho ? (
              <Editor
                plano={rascunho}
                onChange={setRascunho}
                onCancelar={() => {
                  setRascunho(null);
                  setErro(null);
                }}
                onGuardar={guardar}
                ocupado={salvar.isPending || !listaLida}
              />
            ) : null}
          </div>
        ) : null}
        <ListaPadrao<PlanoDeTarefas>
          rotulo={t("Planos de tarefa")}
          descricao={t(
            "Monte a sequência uma vez; a ação Aplicar um plano de tarefas aplica o plano ao negócio.",
          )}
          acoes={
            <Button
              type="button"
              disabled={!listaLida}
              onClick={() => {
                setErro(null);
                setRascunho(novoPlano());
              }}
            >
              {t("Novo plano")}
            </Button>
          }
          resumo={[
            { rotulo: t("Planos"), valor: String(planos.length) },
            { rotulo: t("Passos no total"), valor: String(totalDePassos) },
            { rotulo: t("Com descrição"), valor: String(comDescricao) },
          ]}
          busca={{ placeholder: t("Buscar por nome") }}
          pilulas={[
            { id: "todos", rotulo: t("Todos"), contagem: planos.length },
            { id: "com", rotulo: t("Com descrição"), contagem: comDescricao },
            { id: "sem", rotulo: t("Sem descrição"), contagem: planos.length - comDescricao },
          ]}
          colunas={[
            {
              id: "nome",
              titulo: t("Nome"),
              celula: (p) => (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-semibold">{p.nome}</span>
                  {p.descricao ? (
                    <span className="truncate text-xs text-[var(--color-text-muted)]">{p.descricao}</span>
                  ) : null}
                </span>
              ),
            },
            { id: "tarefas", titulo: t("Tarefas"), celula: (p) => p.passos.length },
          ]}
          linhas={planos}
          chave={(p) => p.id}
          filtrar={(p, { busca, pilula }) =>
            (pilula === "todos" || (pilula === "com") === !!p.descricao?.trim()) &&
            p.nome.toLowerCase().includes(busca.trim().toLowerCase())
          }
          tituloDoPainel={(p) => p.nome}
          painel={(p, fechar) => (
            <div className="space-y-4">
              {p.descricao ? <p className="text-sm text-[var(--color-text-muted)]">{p.descricao}</p> : null}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t("Passos do plano")}
                </h3>
                <ol className="space-y-2 text-sm">
                  {p.passos.map((passo) => (
                    <li key={passo.ordem}>
                      {passo.ordem}. {passo.titulo} — {t("Vence em (dias)")} {passo.vence_em_dias}
                    </li>
                  ))}
                </ol>
              </section>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setErro(null);
                    setRascunho({ ...p, descricao: p.descricao, passos: p.passos.map((x) => ({ ...x })) });
                    fechar();
                  }}
                >
                  {t("Editar")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    excluir(p);
                    fechar();
                  }}
                >
                  {t("Excluir")}
                </Button>
              </div>
            </div>
          )}
          vazio={q.isLoading ? <Skeleton className="mx-auto h-10 w-full" /> : t("Nenhum plano cadastrado ainda.")}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6" data-rd-inicio={rd("planos-tela")}>
      <div>
        <Link
          href="/app/tasks"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text"
        >
          <ArrowBendUpLeft size={14} aria-hidden />
          {t("Tarefas")}
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3" data-rd-inicio={rd("planos-cabecalho")}>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Planos de tarefa")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Monte a sequência uma vez; a ação Aplicar um plano de tarefas aplica o plano ao negócio.",
            )}
          </p>
        </div>
        <Button
          type="button"
          disabled={!listaLida}
          onClick={() => {
            setErro(null);
            setRascunho(novoPlano());
          }}
        >
          {t("Novo plano")}
        </Button>
      </header>

      {erro ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {erro}
        </p>
      ) : null}

      {rascunho ? (
        <Editor
          plano={rascunho}
          onChange={setRascunho}
          onCancelar={() => {
            setRascunho(null);
            setErro(null);
          }}
          onGuardar={guardar}
          ocupado={salvar.isPending || !listaLida}
        />
      ) : null}

      {q.isLoading ? <Skeleton className="h-40 w-full" /> : null}

      {q.isError && !listaLida ? (
        <Card role="alert" className="space-y-2 p-4 text-sm">
          <p>
            {t(
              "Não foi possível carregar os planos. Para não apagar os que já existem, criar e salvar ficam desativados até a lista carregar.",
            )}
          </p>
          <Button type="button" variant="outline" onClick={() => void q.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      ) : null}

      {listaLida && planos.length === 0 && !rascunho ? (
        <Card className="p-4 text-sm text-muted-foreground">
          {t("Nenhum plano cadastrado ainda.")}
        </Card>
      ) : null}

      {planos.map((plano) => (
        <Card key={plano.id} className="space-y-2 p-4" data-rd-inicio={rd("planos-cartao")}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-medium">{plano.nome}</h2>
              {plano.descricao ? (
                <p className="break-words text-sm text-muted-foreground">{plano.descricao}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setErro(null);
                  setRascunho({ ...plano, descricao: plano.descricao, passos: plano.passos.map((p) => ({ ...p })) });
                }}
              >
                {t("Editar")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => excluir(plano)}>
                {t("Excluir")}
              </Button>
            </div>
          </div>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {plano.passos.map((passo) => (
              <li key={passo.ordem}>
                {passo.ordem}. {passo.titulo} — {t("Vence em (dias)")} {passo.vence_em_dias}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

function Editor({
  plano,
  onChange,
  onCancelar,
  onGuardar,
  ocupado,
}: {
  plano: PlanoDeTarefas;
  onChange: (p: PlanoDeTarefas) => void;
  onCancelar: () => void;
  onGuardar: () => void;
  ocupado: boolean;
}) {
  const t = useT();
  const rd = useMarcaDoInicio();
  const { data: members } = useAssignableMembers(true);

  function mudarPasso(indice: number, campo: Partial<PassoDePlano>) {
    onChange({
      ...plano,
      passos: plano.passos.map((p, i) => (i === indice ? { ...p, ...campo } : p)),
    });
  }

  return (
    <Card className="space-y-4 p-4" data-rd-inicio={rd("planos-editor")}>
      <div className="space-y-1">
        <Label htmlFor="plano-nome">{t("Nome do plano")}</Label>
        <Input
          id="plano-nome"
          value={plano.nome}
          onChange={(e) => onChange({ ...plano, nome: e.target.value })}
          placeholder={t("Proposta enviada")}
          maxLength={LIMITES_DO_PLANO.nome}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="plano-descricao">{t("Descrição (opcional)")}</Label>
        <Textarea
          id="plano-descricao"
          value={plano.descricao ?? ""}
          onChange={(e) => onChange({ ...plano, descricao: e.target.value })}
          maxLength={LIMITES_DO_PLANO.descricao}
          aria-describedby="plano-descricao-contador"
        />
        <p id="plano-descricao-contador" className="text-right text-xs text-muted-foreground">
          {(plano.descricao ?? "").length}/{LIMITES_DO_PLANO.descricao}
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("Passos do plano")}</h3>
        {plano.passos.map((passo, indice) => (
          <div key={indice} className="space-y-2 rounded-md border p-3" data-rd-inicio={rd("planos-passo")}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {t("Passo")} {indice + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({ ...plano, passos: plano.passos.filter((_, i) => i !== indice) })
                }
              >
                {t("Remover passo")}
              </Button>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`passo-titulo-${indice}`}>{t("Título")}</Label>
              <Input
                id={`passo-titulo-${indice}`}
                value={passo.titulo}
                onChange={(e) => mudarPasso(indice, { titulo: e.target.value })}
                placeholder={t("Ligar para {{contact.name}} sobre {{lead.title}}")}
                maxLength={LIMITES_DO_PLANO.tituloDoPasso}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor={`passo-prazo-${indice}`}>{t("Vence em (dias)")}</Label>
                <Input
                  id={`passo-prazo-${indice}`}
                  type="number"
                  min={0}
                  max={LIMITES_DO_PLANO.venceEmDias}
                  step={1}
                  value={passo.vence_em_dias}
                  onChange={(e) => mudarPasso(indice, { vence_em_dias: Number(e.target.value) })}
                />
              </div>

              <div className="space-y-1">
                <Label>{t("Prioridade")}</Label>
                <Select
                  value={passo.prioridade}
                  onValueChange={(v) => mudarPasso(indice, { prioridade: v as PrioridadeDaTarefa })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rotuloDaPrioridade(t, passo.prioridade)} />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORIDADES_DA_TAREFA.map((p) => (
                      <SelectItem key={p} value={p}>
                        {rotuloDaPrioridade(t, p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>{t("Atribuir a")}</Label>
                <Select
                  value={
                    typeof passo.atribuir_a === "object" ? passo.atribuir_a.usuario_id : "dono_do_lead"
                  }
                  onValueChange={(v) =>
                    mudarPasso(indice, {
                      atribuir_a: v === "dono_do_lead" ? "dono_do_lead" : { usuario_id: v },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("Dono do negócio")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dono_do_lead">{t("Dono do negócio")}</SelectItem>
                    {(members ?? []).map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {rotuloDoMembro(m, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          disabled={plano.passos.length >= LIMITES_DO_PLANO.passos}
          onClick={() => onChange({ ...plano, passos: [...plano.passos, novoPasso()] })}
        >
          {t("Adicionar passo")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "O que é salvo aqui é o que o editor de regras oferece na ação Aplicar um plano de tarefas.",
        )}
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancelar}>
          {t("Cancelar")}
        </Button>
        <Button type="button" onClick={onGuardar} disabled={ocupado}>
          {ocupado ? t("Salvando…") : t("Salvar plano")}
        </Button>
      </div>
    </Card>
  );
}
