"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Membro da agência (migration 0974): marcar e remover pelo painel da plataforma.
 *
 * A escrita inteira mora em `fn_membro_da_agencia_definir` (security definer, só service_role), que confere de
 * novo o admin da plataforma de escopo `full` pelo ator em parâmetro e grava `agency_member.added/removed` na
 * auditoria. Esta action confere o que o banco não vê: a sessão (`requirePlatformAdmin`), o escopo `full` e o
 * segundo fator provado NA SESSÃO (`mfaEmDivida`), a mesma régua de `planoDaOrganizacao.ts` e da criação de
 * organização. Erro do banco nunca vira texto cru na tela: só as frases fixas abaixo.
 */

const entrada = z.object({
  organizationId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(254),
  ativo: z.boolean(),
});

export type ResultadoDoMembroDaAgencia = { ok: true; acao: string } | { ok: false; error: string };

function mensagemDoErro(error: { code?: string; message?: string } | null): string {
  const texto = error?.message ?? "";
  if (error?.code === "P0002") {
    if (texto.includes("usuario_nao_encontrado")) {
      return "Não existe usuário com esse e-mail. A pessoa precisa ter conta antes de entrar como agência.";
    }
    if (texto.includes("organizacao_nao_encontrada")) return "Organização não encontrada.";
    if (texto.includes("membro_da_agencia_nao_encontrado")) return "Essa pessoa não é membro da agência nesta organização.";
  }
  if (error?.code === "23514" && texto.includes("organizacao_sem_admin")) {
    return "A organização ficaria sem administrador. Espere o dono aceitar o convite antes de remover.";
  }
  if (error?.code === "42501") return "Seu acesso não permite esta ação.";
  logger.error("[membrosDaAgencia] erro na escrita", { code: error?.code ?? null, message: texto });
  return "Não foi possível salvar. Tente de novo.";
}

export async function definirMembroDaAgencia(input: {
  organizationId: string;
  email: string;
  ativo: boolean;
}): Promise<ResultadoDoMembroDaAgencia> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite alterar a agência." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entrada.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Informe um e-mail válido." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_membro_da_agencia_definir", {
    p_org: parsed.data.organizationId,
    p_user_email: parsed.data.email,
    p_ativo: parsed.data.ativo,
    p_actor: user.id,
  });
  if (error) return { ok: false, error: mensagemDoErro(error) };

  revalidatePath(`/admin/tenants/${parsed.data.organizationId}`);
  const acao = (data as { acao?: string } | null)?.acao ?? "";
  return { ok: true, acao };
}
