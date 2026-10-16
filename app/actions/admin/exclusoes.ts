"use server";

/**
 * As ações do admin da PLATAFORMA sobre a exclusão dos dados das organizações (migration 0959, D-209): listar o
 * que está programado, programar à mão (conta de acesso concedido pelo admin, que a regra automática nunca
 * programa), cancelar e excluir agora. O mesmo gate de `reembolsos.ts`: `requirePlatformAdmin`, escopo `full` e
 * MFA em dia, inclusive na leitura (o suporte só leitura nem vê a lista).
 *
 * "Excluir agora" é destrutivo e irreversível: exige digitar o nome da organização EXATAMENTE como está no
 * cadastro e confirmar. Executa a mesma exclusão do cron (Storage, conexões, banco) com `forcar`: não cria nem
 * altera programação nenhuma, então uma falha no meio não deixa nada agendado para o cron das 06:00.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { diasRestantes } from "@/lib/retencao/exclusao-de-organizacao/datas";
import { excluirOrganizacao } from "@/lib/retencao/exclusao-de-organizacao/rodada";
import { createAdminClient } from "@/lib/supabase/admin";

const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos.";
const MENSAGEM_GENERICA = "Não foi possível concluir. Tente de novo.";
const MENSAGEM_LEITURA = "Não foi possível carregar as exclusões.";
const MENSAGEM_SEM_ESCOPO = "Seu acesso de suporte não permite mexer nas exclusões.";
const CAMINHO_DA_TELA = "/admin/sistema/exclusoes";
const LIMITE_DA_LISTA = 200;

export interface ExclusaoListada {
  organizationId: string;
  empresa: string;
  origem: "automatica" | "manual";
  motivo: "cancelada" | "suspensa" | "manual";
  estado: "programada" | "cancelada";
  excluirEm: string;
  fimDaAssinaturaEm: string | null;
  aviso30DiasEm: string | null;
  aviso7DiasEm: string | null;
}

export interface OrganizacaoParaProgramar {
  id: string;
  empresa: string;
}

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return { requestId: hdrs.get("x-request-id"), ip: ipDoCliente(hdrs), userAgent: hdrs.get("user-agent") };
}

async function autorizar(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const { user, platformAdmin } = await requirePlatformAdmin();
  if (platformAdmin.scope !== "full") return { ok: false, error: MENSAGEM_SEM_ESCOPO };
  if (await mfaEmDivida()) return { ok: false, error: MENSAGEM_MFA };
  return { ok: true, userId: user.id };
}

function nomeDaEmpresa(valor: string | null | undefined): string {
  const nome = typeof valor === "string" ? valor.trim() : "";
  return nome.length > 0 ? nome : "Sem nome";
}

export async function listarExclusoes(): Promise<
  { ok: true; exclusoes: ExclusaoListada[]; organizacoes: OrganizacaoParaProgramar[] } | { ok: false; error: string }
> {
  const gate = await autorizar();
  if (!gate.ok) return gate;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("org_exclusoes_programadas" as never)
      .select("organization_id, origem, motivo, estado, fim_da_assinatura_em, excluir_em, aviso_30_dias_em, aviso_7_dias_em")
      .order("excluir_em", { ascending: true })
      .limit(LIMITE_DA_LISTA);
    if (error) throw new Error((error as { message: string }).message);
    const linhas =
      (data as unknown as {
        organization_id: string;
        origem: ExclusaoListada["origem"];
        motivo: ExclusaoListada["motivo"];
        estado: ExclusaoListada["estado"];
        fim_da_assinatura_em: string | null;
        excluir_em: string;
        aviso_30_dias_em: string | null;
        aviso_7_dias_em: string | null;
      }[] | null) ?? [];

    const { data: orgs, error: erroOrgs } = await admin
      .from("organizations")
      .select("id, display_name")
      .order("display_name", { ascending: true })
      .limit(500);
    if (erroOrgs) throw new Error(`organizations: ${erroOrgs.message}`);
    const nomes = new Map<string, string>();
    for (const o of (orgs as { id: string; display_name: string | null }[] | null) ?? []) {
      nomes.set(o.id, nomeDaEmpresa(o.display_name));
    }
    const programadas = new Set(linhas.map((l) => l.organization_id));
    return {
      ok: true,
      exclusoes: linhas.map((l) => ({
        organizationId: l.organization_id,
        empresa: nomes.get(l.organization_id) ?? "Sem nome",
        origem: l.origem,
        motivo: l.motivo,
        estado: l.estado,
        excluirEm: l.excluir_em,
        fimDaAssinaturaEm: l.fim_da_assinatura_em,
        aviso30DiasEm: l.aviso_30_dias_em,
        aviso7DiasEm: l.aviso_7_dias_em,
      })),
      organizacoes: [...nomes.entries()]
        .filter(([id]) => !programadas.has(id))
        .map(([id, empresa]) => ({ id, empresa })),
    };
  } catch (err) {
    logger.error("[exclusao] listar falhou", { erro: err instanceof Error ? err.message.slice(0, 200) : "erro" });
    return { ok: false, error: MENSAGEM_LEITURA };
  }
}

const entradaProgramar = z.object({
  organizationId: z.string().uuid(),
  /** Dia civil `aaaa-mm-dd`, de amanhã em diante (fuso de São Paulo). */
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function programarExclusao(input: {
  organizationId: string;
  data: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await autorizar();
  if (!gate.ok) return gate;
  const parsed = entradaProgramar.safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };

  // 05:00 UTC do dia escolhido = 02:00 em São Paulo, antes da rodada das 06:00 UTC.
  const quando = new Date(`${parsed.data.data}T05:00:00.000Z`);
  if (Number.isNaN(quando.getTime()) || diasRestantes(quando, new Date()) < 1) {
    return { ok: false, error: "Escolha uma data a partir de amanhã." };
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("fn_exclusao_programar" as never, {
    p_org: parsed.data.organizationId,
    p_quando: quando.toISOString(),
    p_actor: gate.userId,
  } as never);
  if (error) {
    if ((error as { message?: string }).message?.includes("exclusao_org_inexistente")) {
      return { ok: false, error: "Organização não encontrada." };
    }
    logger.error("[exclusao] programar falhou", { code: (error as { code?: string }).code ?? null });
    return { ok: false, error: MENSAGEM_GENERICA };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "org.deletion_scheduled",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { origem: "manual", excluir_em: quando.toISOString() },
    requestId,
    ip,
    userAgent,
  });
  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true };
}

export async function cancelarExclusao(input: {
  organizationId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await autorizar();
  if (!gate.ok) return gate;
  const parsed = z.object({ organizationId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_exclusao_cancelar" as never, {
    p_org: parsed.data.organizationId,
    p_actor: gate.userId,
  } as never);
  if (error) {
    logger.error("[exclusao] cancelar falhou", { code: (error as { code?: string }).code ?? null });
    return { ok: false, error: MENSAGEM_GENERICA };
  }
  if (data === "inexistente" || data === "ja_cancelada") return { ok: false, error: "Esta exclusão já não está programada." };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "org.deletion_cancelled",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { origem: "admin", resultado: data },
    requestId,
    ip,
    userAgent,
  });
  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true };
}

const entradaExcluirAgora = z.object({
  organizationId: z.string().uuid(),
  nomeDigitado: z.string().min(1).max(300),
  confirmar: z.literal(true),
});

export async function excluirAgora(input: {
  organizationId: string;
  nomeDigitado: string;
  confirmar: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await autorizar();
  if (!gate.ok) return gate;
  const parsed = entradaExcluirAgora.safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };

  const admin = createAdminClient();
  const { data: org, error: erroOrg } = await admin
    .from("organizations")
    .select("display_name")
    .eq("id", parsed.data.organizationId)
    .maybeSingle();
  if (erroOrg || !org) return { ok: false, error: "Organização não encontrada." };
  // O nome EXATO, sem aparar e sem ignorar maiúsculas: quem digita precisa estar olhando para o nome.
  if (parsed.data.nomeDigitado !== nomeDaEmpresa((org as { display_name: string | null }).display_name)) {
    return { ok: false, error: "O nome digitado não confere com o da organização." };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  // Antes: a exclusão apaga a organização, e a linha de quem pediu precisa existir. A auditoria final
  // (`org.data_purged`) é gravada pelo banco dentro da própria exclusão.
  await audit({
    action: "org.deletion_scheduled",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { origem: "manual", excluir_agora: true },
    requestId,
    ip,
    userAgent,
  });

  // `forcar`: a exclusão pedida à mão não cria nem altera programação. Se falhar, a programação que existia
  // (automática ou manual) continua exatamente como estava, e o cron das 06:00 não herda nada.
  const r = await excluirOrganizacao(admin, parsed.data.organizationId, gate.userId, { forcar: true });
  if (!r.ok) {
    return {
      ok: false,
      error:
        r.etapa === "armazenamento"
          ? "Não foi possível apagar os arquivos da organização. Nada foi excluído; tente de novo."
          : MENSAGEM_GENERICA,
    };
  }
  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true };
}
