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
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { gatilhosDoGrafo } from "@/lib/automacoes/gatilhos";
import { iniciarAutomacao } from "@/lib/automacoes/iniciar";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ contact_id: z.string().uuid() });

const MENSAGEM: Record<string, string> = {
  iniciada: "Automação iniciada para o contato.",
  reiniciada: "A execução anterior foi encerrada e a automação recomeçou.",
  ja_em_execucao: "Este contato já está nesta automação.",
  em_espera: "Este contato terminou esta automação há pouco; aguarde o intervalo configurado.",
  limite_por_hora: "Este contato já entrou nesta automação 10 vezes na última hora.",
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

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: corpo.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = e.deps.admin;
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
  if (!gatilhos?.triggers.some((g) => g.kind === "manual")) {
    return fail(
      "trigger_not_manual",
      t("Esta automação não tem o gatilho Manual. Acrescente-o no Início e publique de novo."),
      422,
      { requestId },
    );
  }

  const inicio = await iniciarAutomacao(admin, {
    organizationId: orgId,
    pointerId: id,
    contactId: corpo.data.contact_id,
    vars: { gatilho: { tipo: "manual", por: userId } },
  });

  if (inicio.resultado === "contato_invalido") {
    return fail("not_found", t(MENSAGEM.contato_invalido!), 404, { requestId });
  }
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
  return ok(
    { resultado: inicio.resultado, enrollment_id: inicio.enrollment_id, mensagem: t(MENSAGEM[inicio.resultado] ?? "") },
    { requestId, status: abriu ? 201 : 200 },
  );
}
