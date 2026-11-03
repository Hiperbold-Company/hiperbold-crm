/**
 * Os EFEITOS dos blocos de automação (lote 1): ações de CRM e operação de campo.
 *
 * Cada ação passa pelos MESMOS handlers que a API REST e o MCP usam
 * (`createLeadHandler`, `moveLeadHandler`, `updateLeadHandler`,
 * `patchContactHandler`, `encerraDemanda`): validação, auditoria e eventos
 * saem iguais, e nada aqui reimplementa regra de negócio.
 *
 * Ator: `webhook_source` com o id da AUTOMAÇÃO (o mesmo desenho das regras,
 * `lib/automation/actions/create-or-move-lead.ts`). `requestId` começa com
 * `automacao:<pointer>:` — é por esse prefixo que o gatilho das automações
 * (`gatilhos.ts`) não reage ao que a própria automação fez, e que as regras
 * antigas (`lib/automation/engine.ts`) também não.
 *
 * ⚠️ Service role ignora RLS: toda leitura e escrita aqui filtra
 * `organization_id` pela INSCRIÇÃO (que veio do banco), nunca por payload.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createLeadHandler, moveLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { organizacaoPodeProduzir } from "@/lib/billing/assinatura/pode-produzir";
import { STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ExecutorDeEfeitos, PedidoDeEfeito, ResultadoDoEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { avisarLimiteDeLeadsAtingido } from "@/lib/leads/aviso-limite-de-leads";
import { selectRoundRobin } from "@/lib/routing/decide";
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

import { aplicarOperacao, campoSoLeitura } from "../campos";
import { carregarFatosDaAutomacao } from "../carregar-fatos";
import { lerCampo } from "../condicoes";
import type { FatosDaAutomacao } from "../fatos";
import type { CrmAction, FieldOp } from "../schemas";
import { renderizar } from "../template-vars";

/** Evento que avisa a equipe (push) — consumido por `lib/notifications/push.handler.ts`. */
export const EVENTO_DE_AVISO_DA_AUTOMACAO = "automacao.aviso";

type Passo = { ok: boolean; erro?: string; vars?: Record<string, unknown>; detalhe: Record<string, unknown> };

interface Contexto {
  admin: SupabaseClient;
  org: string;
  pointerId: string;
  enrollmentId: string;
  contatoId: string;
  fatos: FatosDaAutomacao | null;
  handler: HandlerCtx;
  agora: Date;
}

function codigoDoErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === STATUS_RECUSA_DO_PLANO) return "plano_limite_atingido";
    return err.code;
  }
  return "efeito_falhou";
}

async function membroAtivo(c: Contexto, userId: string): Promise<boolean> {
  const { data, error } = await c.admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", c.org)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error("membro_indeterminado");
  return Boolean(data) && (data as { role: string }).role !== "viewer";
}

/** O negócio que as ações de negócio usam: o da execução, ou o aberto mais recente do contato. */
function negocioAlvo(c: Contexto): string | null {
  return c.fatos?.negocio?.id ?? null;
}

async function rodizio(c: Contexto, ids: string[] | undefined): Promise<string | null> {
  let candidatos = ids ?? [];
  if (candidatos.length === 0) {
    const { data, error } = await c.admin
      .from("user_organizations")
      .select("user_id, role")
      .eq("organization_id", c.org)
      .is("revoked_at", null);
    if (error) throw new Error("membro_indeterminado");
    candidatos = ((data ?? []) as Array<{ user_id: string; role: string }>)
      .filter((m) => m.role !== "viewer")
      .map((m) => m.user_id);
  } else {
    const validos: string[] = [];
    for (const id of candidatos) if (await membroAtivo(c, id)) validos.push(id);
    candidatos = validos;
  }
  if (candidatos.length === 0) return null;
  // "Último atribuído" derivado dos negócios (DIRC: calcular, sem coluna de estado).
  const { data } = await c.admin
    .from("crm_leads")
    .select("owner_user_id, assigned_at")
    .eq("organization_id", c.org)
    .in("owner_user_id", candidatos)
    .not("assigned_at", "is", null)
    .order("assigned_at", { ascending: false })
    .limit(500);
  const ultimo = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ owner_user_id: string; assigned_at: string }>) {
    if (!ultimo.has(r.owner_user_id)) ultimo.set(r.owner_user_id, Date.parse(r.assigned_at));
  }
  return selectRoundRobin(candidatos.map((userId) => ({ userId, currentLoad: 0, lastAssignedAt: ultimo.get(userId) ?? null })));
}

async function executarAcao(c: Contexto, acao: CrmAction): Promise<Passo> {
  const base = { tipo: acao.type };
  switch (acao.type) {
    case "create_deal": {
      const existente = c.fatos?.negocios.find((n) => n.pipeline_id === acao.pipeline_id && n.status === "open");
      if (existente && acao.if_open_exists === "skip") {
        return { ok: true, vars: { _lead_id: existente.id }, detalhe: { ...base, resultado: "ja_existia", lead_id: existente.id } };
      }
      if (existente && acao.if_open_exists === "move") {
        if (existente.stage_id !== acao.stage_id) {
          await moveLeadHandler(c.admin, c.handler, existente.id, { to_stage_id: acao.stage_id });
        }
        return { ok: true, vars: { _lead_id: existente.id }, detalhe: { ...base, resultado: "movido", lead_id: existente.id } };
      }
      const titulo =
        (acao.title ? renderizar(acao.title, c.fatos, c.agora).trim() : "") ||
        nomeDoContato(c.fatos?.contato ?? null) ||
        c.fatos?.contato?.phone_number ||
        "Negócio da automação";
      const criado = await createLeadHandler(c.admin, c.handler, {
        pipeline_id: acao.pipeline_id,
        stage_id: acao.stage_id,
        title: titulo.slice(0, 200).padEnd(2, "."),
        contact_id: c.contatoId,
        source: "automation",
        tags: [],
        ...(acao.value_cents !== undefined ? { value_cents: acao.value_cents } : {}),
      } as Parameters<typeof createLeadHandler>[2]);
      const id = String((criado as { id: unknown }).id);
      return { ok: true, vars: { _lead_id: id }, detalhe: { ...base, resultado: "criado", lead_id: id } };
    }
    case "move_deal": {
      const daExecucao = c.fatos?.negocio;
      const alvo =
        daExecucao && daExecucao.pipeline_id === acao.pipeline_id
          ? daExecucao.id
          : c.fatos?.negocios.find((n) => n.pipeline_id === acao.pipeline_id && n.status === "open")?.id;
      if (!alvo) return { ok: false, erro: "sem_negocio", detalhe: base };
      await moveLeadHandler(c.admin, c.handler, alvo, { to_stage_id: acao.stage_id });
      return { ok: true, vars: { _lead_id: alvo }, detalhe: { ...base, lead_id: alvo } };
    }
    case "win_deal":
    case "lose_deal": {
      const alvo = negocioAlvo(c);
      if (!alvo) return { ok: false, erro: "sem_negocio", detalhe: base };
      const motivo = acao.reason ? renderizar(acao.reason, c.fatos, c.agora) : null;
      await encerraDemanda(c.admin, c.handler, {
        leadId: alvo,
        desfecho: acao.type === "win_deal" ? "won" : "lost",
        motivo,
      });
      return { ok: true, detalhe: { ...base, lead_id: alvo } };
    }
    case "add_tags":
    case "remove_tags": {
      const dono = acao.target === "lead" ? c.fatos?.negocio : c.fatos?.contato;
      if (!dono) return { ok: false, erro: acao.target === "lead" ? "sem_negocio" : "sem_contato", detalhe: base };
      const atuais = dono.tags ?? [];
      const igual = (a: string, b: string) => a.toLocaleLowerCase("pt-BR") === b.toLocaleLowerCase("pt-BR");
      const novas =
        acao.type === "add_tags"
          ? [...atuais, ...acao.tags.filter((t) => !atuais.some((a) => igual(a, t)))]
          : atuais.filter((a) => !acao.tags.some((t) => igual(a, t)));
      if (novas.length === atuais.length && novas.every((t, i) => t === atuais[i])) {
        return { ok: true, detalhe: { ...base, resultado: "sem_mudanca" } };
      }
      if (acao.target === "lead") await updateLeadHandler(c.admin, c.handler, dono.id, { tags: novas });
      else await patchContactHandler(c.admin, c.handler, dono.id, { tags: novas });
      return { ok: true, detalhe: { ...base, alvo: acao.target } };
    }
    case "set_owner": {
      const alvo = negocioAlvo(c);
      if (!alvo) return { ok: false, erro: "sem_negocio", detalhe: base };
      const userId =
        acao.mode.m === "user"
          ? (await membroAtivo(c, acao.mode.user_id))
            ? acao.mode.user_id
            : null
          : await rodizio(c, acao.mode.user_ids);
      if (!userId) return { ok: false, erro: "sem_responsavel", detalhe: base };
      await updateLeadHandler(c.admin, c.handler, alvo, { owner_user_id: userId });
      return { ok: true, detalhe: { ...base, user_id: userId, lead_id: alvo } };
    }
    case "notify": {
      const dono = c.fatos?.negocio?.owner_user_id ?? null;
      const para = acao.to === "owner" ? (dono ? [dono] : []) : acao.to;
      if (para.length === 0) return { ok: false, erro: "sem_responsavel", detalhe: base };
      const texto = renderizar(acao.message, c.fatos, c.agora).slice(0, 500);
      for (const userId of para) {
        if (!(await membroAtivo(c, userId))) continue;
        const { error } = await c.admin.rpc("emit_event", {
          p_event_type: EVENTO_DE_AVISO_DA_AUTOMACAO,
          p_entity_kind: "contact",
          p_entity_id: c.contatoId,
          p_payload: { to_user_id: userId, body: texto, lead_id: c.fatos?.negocio?.id ?? null, pointer_id: c.pointerId },
          p_metadata: { request_id: c.handler.requestId, caused_by_automation: { pointer_id: c.pointerId, enrollment_id: c.enrollmentId } },
          p_organization_id: c.org,
        });
        if (error) return { ok: false, erro: "efeito_falhou", detalhe: base };
      }
      return { ok: true, detalhe: { ...base, destinatarios: para.length } };
    }
    case "create_task": {
      const dono = c.fatos?.negocio?.owner_user_id ?? null;
      const responsavel = acao.assignee === "owner" ? dono : (await membroAtivo(c, acao.assignee)) ? acao.assignee : null;
      const titulo = renderizar(acao.title, c.fatos, c.agora).trim().slice(0, 255) || "Tarefa da automação";
      const due = new Date(c.agora.getTime() + acao.due_in_minutes * 60_000).toISOString();
      const { data, error } = await c.admin
        .from("crm_tasks")
        .insert({
          organization_id: c.org,
          title: titulo,
          due_date: due,
          priority: "medium",
          status: "pending",
          lead_id: c.fatos?.negocio?.id ?? null,
          contact_id: c.contatoId,
          assigned_to: responsavel,
          created_by: null,
        })
        .select("id")
        .single();
      if (error || !data) return { ok: false, erro: "efeito_falhou", detalhe: base };
      void audit({
        organizationId: c.org,
        actorUserId: null,
        action: "crm_task.created",
        resourceType: "crm_tasks",
        resourceId: (data as { id: string }).id,
        requestId: c.handler.requestId,
        metadata: { actor_type: "webhook_source", actor_id: c.pointerId, origem: "automacao", due_date: due },
      });
      return { ok: true, detalhe: { ...base, task_id: (data as { id: string }).id } };
    }
    case "add_note": {
      const lead = c.fatos?.negocio;
      // A nota mora na linha do tempo do negócio (`crm_lead_activities.lead_id` é not null).
      if (!lead) return { ok: false, erro: "sem_negocio", detalhe: base };
      const texto = renderizar(acao.body, c.fatos, c.agora).slice(0, 2000);
      const row = buildLeadActivityRow({
        organizationId: c.org,
        leadId: lead.id,
        contactId: c.contatoId,
        type: "note",
        sourceModule: "automacao",
        sourceId: c.pointerId,
        actor: c.handler.actor,
        reason: "Nota da automação",
        payload: { subtype: "nota", text: texto, alvo: acao.target },
      });
      const { error } = await c.admin.from("crm_lead_activities").insert(row);
      if (error) return { ok: false, erro: "efeito_falhou", detalhe: base };
      return { ok: true, detalhe: { ...base, lead_id: lead.id } };
    }
  }
}

async function camposDoFunil(c: Contexto, pipelineId: string): Promise<Map<string, CustomFieldDef>> {
  const { data } = await c.admin
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", c.org)
    .eq("id", pipelineId)
    .maybeSingle();
  const lista = ((data as { settings?: { fields?: unknown[] } } | null)?.settings?.fields ?? []) as unknown[];
  const mapa = new Map<string, CustomFieldDef>();
  for (const bruto of lista) {
    const p = customFieldSchema.safeParse(bruto);
    if (p.success) mapa.set(p.data.key, p.data);
  }
  return mapa;
}

const TIPO_PADRAO: Partial<Record<string, Pick<CustomFieldDef, "type">>> = {
  email: { type: "email" },
  phone_number: { type: "phone" },
  birthdate: { type: "date" },
  value_cents: { type: "number" },
  expected_close_date: { type: "date" },
};

/** Campos padrão que a operação de campo NÃO escreve: têm bloco próprio (etapa, dono) ou são do sistema. */

async function executarOperacoes(c: Contexto, ops: FieldOp[]): Promise<Passo> {
  const patchLead: Record<string, unknown> = {};
  const customLead: Record<string, unknown> = {};
  const patchContato: Record<string, unknown> = {};
  const customContato: Record<string, unknown> = {};
  const lead = c.fatos?.negocio ?? null;
  const contato = c.fatos?.contato ?? null;
  const defs = lead ? await camposDoFunil(c, lead.pipeline_id) : new Map<string, CustomFieldDef>();
  const feitos: string[] = [];

  for (const op of ops) {
    const alvo = op.target;
    if (alvo.scope === "var") return { ok: false, erro: "valor_invalido:variavel", detalhe: { tipo: "field_op" } };
    if ((alvo.scope === "lead" || alvo.scope === "lead_custom") && !lead) {
      return { ok: false, erro: "sem_negocio", detalhe: { tipo: "field_op" } };
    }
    if ((alvo.scope === "contact" || alvo.scope === "contact_custom") && !contato) {
      return { ok: false, erro: "sem_contato", detalhe: { tipo: "field_op" } };
    }
    if (campoSoLeitura(alvo)) {
      return { ok: false, erro: `valor_invalido:${alvo.key}`, detalhe: { tipo: "field_op", campo: alvo.key } };
    }
    const texto = op.value ? renderizar(op.value, c.fatos, c.agora) : "";
    const atual =
      alvo.scope === "lead_custom" && alvo.key in customLead
        ? customLead[alvo.key]
        : alvo.scope === "contact_custom" && alvo.key in customContato
          ? customContato[alvo.key]
          : c.fatos
            ? lerCampo(alvo, c.fatos)
            : undefined;
    const def =
      alvo.scope === "lead_custom"
        ? (defs.get(alvo.key) ?? null)
        : alvo.scope === "lead" || alvo.scope === "contact"
          ? ((TIPO_PADRAO[alvo.key] as Pick<CustomFieldDef, "type"> | undefined) ?? null)
          : null;
    if (alvo.key === "tags") {
      const lista = texto.split(",").map((t) => t.trim()).filter(Boolean);
      const anteriores = Array.isArray(atual) ? (atual as string[]) : [];
      const valor = op.op === "clear" ? [] : op.op === "append" ? [...anteriores, ...lista.filter((t) => !anteriores.includes(t))] : lista;
      (alvo.scope === "lead" ? patchLead : patchContato).tags = valor;
      feitos.push(alvo.key);
      continue;
    }
    const r = aplicarOperacao(op.op, atual, texto, def as Pick<CustomFieldDef, "type" | "options"> | null);
    if (!r.ok) {
      return { ok: false, erro: `${r.erro}:${alvo.key}`, detalhe: { tipo: "field_op", campo: alvo.key } };
    }
    let valor = r.valor;
    if (alvo.scope === "lead" && alvo.key === "value_cents" && typeof valor === "number") valor = Math.round(valor);
    if (alvo.scope === "lead") patchLead[alvo.key] = valor;
    else if (alvo.scope === "lead_custom") customLead[alvo.key] = valor;
    else if (alvo.scope === "contact") patchContato[alvo.key] = valor;
    else customContato[alvo.key] = valor;
    feitos.push(alvo.key);
  }

  if (lead && (Object.keys(patchLead).length > 0 || Object.keys(customLead).length > 0)) {
    await updateLeadHandler(c.admin, c.handler, lead.id, {
      ...patchLead,
      ...(Object.keys(customLead).length > 0 ? { custom_fields: customLead } : {}),
    } as Parameters<typeof updateLeadHandler>[3]);
  }
  if (contato && (Object.keys(patchContato).length > 0 || Object.keys(customContato).length > 0)) {
    await patchContactHandler(c.admin, c.handler, contato.id, {
      ...patchContato,
      // O PATCH do contato SUBSTITUI custom_fields: mescla com o que já existe.
      ...(Object.keys(customContato).length > 0 ? { custom_fields: { ...contato.custom_fields, ...customContato } } : {}),
    } as Parameters<typeof patchContactHandler>[3]);
  }
  return { ok: true, detalhe: { tipo: "field_op", campos: feitos } };
}

function contextoDe(admin: SupabaseClient, pedido: PedidoDeEfeito, agora: Date): Contexto {
  const { enrollment } = pedido;
  return {
    admin,
    org: enrollment.organization_id,
    pointerId: enrollment.pointer_id,
    enrollmentId: enrollment.id,
    contatoId: enrollment.contact_id,
    fatos: pedido.fatos,
    agora,
    handler: {
      organization_id: enrollment.organization_id,
      actor: { type: "webhook_source", id: enrollment.pointer_id },
      requestId: `automacao:${enrollment.pointer_id}:${enrollment.id}:${pedido.chave}`,
    },
  };
}

export function criarExecutorDeEfeitos(
  admin: SupabaseClient,
  opts: {
    clock?: () => Date;
    /** Recarrega os fatos depois de uma ação que criou/moveu negócio (o passo seguinte do MESMO bloco vê o negócio novo). */
    recarregarFatos?: (pedido: PedidoDeEfeito, vars: Record<string, unknown>) => Promise<FatosDaAutomacao | null>;
    /** Organização suspensa (plataforma ou cobrança) não muda o CRM sozinha. Padrão: `organizacaoPodeProduzir`. */
    podeProduzir?: (organizationId: string) => Promise<boolean>;
  } = {},
): ExecutorDeEfeitos {
  const clock = opts.clock ?? (() => new Date());
  const podeProduzir = opts.podeProduzir ?? ((org: string) => organizacaoPodeProduzir(admin, org));
  return {
    async executar(pedido): Promise<ResultadoDoEfeito> {
      const node: FlowNode = pedido.node;
      // Antes de qualquer leitura ou escrita: a execução que já estava na fila
      // quando a conta foi suspensa não age por ela.
      if (!(await podeProduzir(pedido.enrollment.organization_id))) {
        return { desfecho: { ok: false, erro: "organizacao_bloqueada" }, detalhes: [{ tipo: node.type }] };
      }
      const c = contextoDe(admin, pedido, clock());
      if (node.type === "field_op") {
        try {
          const r = await executarOperacoes(c, node.config.ops);
          return { desfecho: r.ok ? { ok: true } : { ok: false, erro: r.erro ?? "efeito_falhou" }, detalhes: [r.detalhe] };
        } catch (err) {
          return { desfecho: { ok: false, erro: codigoDoErro(err) }, detalhes: [{ tipo: "field_op" }] };
        }
      }
      if (node.type !== "crm_action") return { desfecho: { ok: false, erro: "efeito_falhou" } };

      const detalhes: Array<Record<string, unknown>> = [];
      let vars: Record<string, unknown> = {};
      let primeiroErro: string | undefined;
      for (const acao of node.config.actions) {
        let passo: Passo;
        try {
          passo = await executarAcao(c, acao);
        } catch (err) {
          const codigo = codigoDoErro(err);
          if (codigo === "plano_limite_atingido") await avisarLimiteDeLeadsAtingido(admin, c.org);
          passo = { ok: false, erro: codigo, detalhe: { tipo: acao.type } };
        }
        detalhes.push({ ...passo.detalhe, ok: passo.ok, ...(passo.erro ? { erro: passo.erro } : {}) });
        if (passo.vars) {
          vars = { ...vars, ...passo.vars };
          const todas = { ...(pedido.fatos?.vars ?? {}), ...vars };
          c.fatos = opts.recarregarFatos
            ? await opts.recarregarFatos(pedido, todas)
            : await carregarFatosDaAutomacao(admin, c.org, c.contatoId, todas);
        }
        if (!passo.ok) {
          primeiroErro ??= passo.erro ?? "efeito_falhou";
          if (node.config.on_error === "route") break;
        }
      }
      return {
        desfecho: primeiroErro ? { ok: false, erro: primeiroErro } : { ok: true },
        ...(Object.keys(vars).length > 0 ? { vars } : {}),
        detalhes,
      };
    },
  };
}
