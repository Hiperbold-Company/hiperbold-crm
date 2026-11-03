import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/automacoes/[id]/executar — gatilho MANUAL: inicia a automação
 * publicada para UM contato ("Testar com um contato" no editor).
 *
 * Gerente+ (mesma régua de editar e publicar fluxos). A organização vem da
 * sessão, nunca do corpo; o corpo só traz o contato, e quem confere que o
 * contato e a automação são DESTA organização é `fn_automacao_iniciar`
 * (service role), que também aplica reentrada, cooldown e o teto por hora.
 * A automação precisa declarar o gatilho manual no Início — senão 422.
 *
 * Organização suspensa (pela plataforma ou pela cobrança) não inicia
 * automação: o mesmo `motivoDeNaoProduzir` dos produtores de follow-up.
 * `Idempotency-Key` opcional (recibo em `idempotency_keys`): a retentativa de
 * um clique não abre segunda execução nem devolve resposta diferente. Token
 * `dsk_…` passa pelo teto de escrita padrão (`tetoDeEscritaDoToken`); a sessão,
 * por um balde da organização com os mesmos números.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia, identidadeDoAtor } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { motivoDeNaoProduzir } from "@/lib/billing/assinatura/pode-produzir";
import { CODIGO_RECUSA_DO_PLANO, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { JANELA_SEGUNDOS, TETO_DE_ESCRITA } from "@/lib/mcp/rate-limit";
import { gatilhosDoGrafo } from "@/lib/automacoes/gatilhos";
import { iniciarAutomacao } from "@/lib/automacoes/iniciar";
import { entradaDeFluxo } from "@/lib/followup/porta";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ contact_id: z.string().uuid() });

const MENSAGEM: Record<string, string> = {
  iniciada: "Automação iniciada para o contato.",
  reiniciada: "A execução anterior foi encerrada e a automação recomeçou.",
  ja_em_execucao: "Este contato já está nesta automação.",
  em_espera: "Este contato terminou esta automação há pouco; aguarde o intervalo configurado.",
  limite_por_hora: "Este contato já entrou nesta automação 10 vezes na última hora.",
  ciclo: "Esta automação foi disparada por outra que ela mesma disparou; a volta foi cortada.",
  cadeia_longa: "Automações disparando umas às outras passaram de 5 passos; a sequência foi cortada.",
  limite_da_organizacao: "Mais de 5000 automações começaram na última hora nesta organização; tente mais tarde.",
  inativa: "Publique a automação antes de testar.",
  contato_invalido: "Contato não encontrado.",
  sem_inicio: "A automação não tem bloco de início.",
  duplicada: "Esta execução já foi aberta.",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  // Mesma porta das rotas de fluxo: gerente+, escrita (MFA e suporte somente leitura), id validado.
  const e = await entradaDeFluxo(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  const { requestId } = e;
  const t = e.deps.t!;
  const orgId = e.deps.organizationId;
  const userId = e.deps.responsavel;

  const tetoDoToken = await tetoDeEscritaDoToken(e.authz, "automacoes-executar", requestId);
  if (tetoDoToken) return tetoDoToken;
  if (e.authz.via !== "token") {
    const balde = await checkRateLimit(`automacoes-executar:org:${orgId}`, TETO_DE_ESCRITA, JANELA_SEGUNDOS);
    if (!balde.allowed) {
      return fail("rate_limited", t("Muitos testes seguidos. Aguarde um minuto."), 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }
  }

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: corpo.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = e.deps.admin;
  const bloqueio = await motivoDeNaoProduzir(admin, orgId);
  if (bloqueio === "assinatura_suspensa") {
    return fail(
      CODIGO_RECUSA_DO_PLANO,
      t("A conta está suspensa por falta de pagamento: as automações ficam paradas até a assinatura ser regularizada. Fale com o suporte."),
      STATUS_RECUSA_DO_PLANO,
      { requestId },
    );
  }
  if (bloqueio === "organizacao_inativa") {
    return fail("organization_inactive", t("Esta organização está suspensa: as automações ficam paradas."), 403, {
      requestId,
    });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", t("Idempotency-Key deve ser um UUID."), 400, { requestId });
  }
  const { data: pointer, error } = await admin
    .from("followup_flow_pointers")
    .select("id, surface, status, active_version_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao ler a automação."), 500, { requestId });
  if (!pointer || pointer.surface !== "automacao") {
    return fail("not_found", t("Automação não encontrada."), 404, { requestId });
  }
  if (pointer.status !== "active" || !pointer.active_version_id) {
    return fail("flow_not_active", t(MENSAGEM.inativa!), 422, { requestId });
  }
  const { data: versao, error: vErr } = await admin
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", orgId)
    .eq("id", pointer.active_version_id)
    .maybeSingle();
  if (vErr || !versao) return fail("internal_error", t("Erro ao ler a automação."), 500, { requestId });
  const gatilhos = gatilhosDoGrafo((versao as { graph: unknown }).graph);
  // "Iniciada por outra automação" também se testa à mão (o "Testar" do editor).
  if (!gatilhos?.triggers.some((g) => g.kind === "manual" || g.kind === "started_by_automation")) {
    return fail(
      "trigger_not_manual",
      t("Esta automação não tem o gatilho Manual. Acrescente-o no Início e publique de novo."),
      422,
      { requestId },
    );
  }

  type Corpo = { resultado: string; enrollment_id: string | null; mensagem: string };
  const executar = async (): Promise<{ resposta: Corpo; status: number }> => {
    const inicio = await iniciarAutomacao(admin, {
      organizationId: orgId,
      pointerId: id,
      contactId: corpo.data.contact_id,
      vars: { gatilho: { tipo: "manual", por: userId } },
    });
    const abriu = inicio.resultado === "iniciada" || inicio.resultado === "reiniciada";
    if (abriu) {
      await audit({
        action: "followup_enrollment.created",
        actorUserId: userId,
        organizationId: orgId,
        resourceType: "followup_enrollments",
        resourceId: inicio.enrollment_id,
        requestId,
        metadata: { origem: "automacao_manual", pointer_id: id, contact_id: corpo.data.contact_id, resultado: inicio.resultado },
      });
    }
    return {
      resposta: { resultado: inicio.resultado, enrollment_id: inicio.enrollment_id, mensagem: t(MENSAGEM[inicio.resultado] ?? "") },
      status: abriu ? 201 : 200,
    };
  };
  const responder = (r: { resposta: Corpo; status: number }): Response =>
    r.resposta.resultado === "contato_invalido"
      ? fail("not_found", t(MENSAGEM.contato_invalido!), 404, { requestId })
      : ok(r.resposta, { requestId, status: r.status === 201 ? 201 : 200 });

  if (chave === null) return responder(await executar());

  const desfecho = await comIdempotencia<Corpo>({
    // Servidor, não a sessão: `idempotency_keys` não é legível nem gravável por `authenticated` (0969).
    db: createAdminClient(),
    organizationId: orgId,
    endpoint: `/api/v1/automacoes/${id}/executar`,
    chave,
    ator: identidadeDoAtor(e.authz.actor),
    corpo: corpo.data,
    executar,
  });
  if (desfecho.tipo === "conflito") {
    return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
      requestId,
    });
  }
  if (desfecho.tipo === "em_curso") {
    return fail(
      "idempotency_in_progress",
      t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
      409,
      { requestId },
    );
  }
  return responder(desfecho);
}
