"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { atualizarInterfaceDaOrganizacao } from "@/lib/organizacao/configuracao";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { portaoDeAdminDaOrganizacao } from "@/lib/auth/portao-de-escrita";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";

export type InterfaceDaEmpresaResult = { ok: true } | { ok: false; error: string };

/**
 * Grava as portas da EMPRESA (issue #1341) — o universo de itens do menu lateral
 * da instalação inteira. Cada vínculo continua escolhendo MENOS dentro dele
 * (`PATCH /api/v1/team/:user_id/interface`); ninguém abre além daqui, porque a
 * leitura resolve a INTERSEÇÃO (`combinarInterfaces`).
 *
 * Isto é configuração de APRESENTAÇÃO, como a escolha por vínculo: não concede
 * nem tira acesso. Papel, RLS e permissões seguem decidindo o que cada pessoa
 * alcança, e desmarcar uma área aqui apenas a esconde — link contextual, aviso e
 * busca continuam abrindo o que o papel autoriza.
 */
export async function atualizarInterfaceDaEmpresa(input: InterfaceSettings): Promise<InterfaceDaEmpresaResult> {
  const parsed = interfaceSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  // Sessão de suporte é somente-leitura: quem está do outro lado não muda o menu
  // da instalação (mesma trava de `updateTenant` e da rota por vínculo).
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  const portao = await portaoDeAdminDaOrganizacao(authUser, activeOrg);
  if (!portao.ok) return { ok: false, error: portao.erro };

  /**
   * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — pelo mesmo motivo medido
   * em `updateTenant` (issue #144): a única policy de escrita da tabela é
   * `orgs_write_platform_admin`, então o UPDATE de um admin de organização pelo
   * client de sessão casa ZERO linhas e o PostgREST devolve sucesso. O gate
   * continua sendo o de cima (papel resolvido de fonte confiável) e o filtro por
   * organização é explícito — a organização vem da SESSÃO, nunca do corpo.
   */
  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  // D-036: o primeiro salto do `x-forwarded-for` é forjável pelo cliente;
  // `ipDoCliente` lê o salto confiável (ver `lib/http/ip-do-cliente.ts`).
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Mesma guarda da escolha por vínculo (`sem_area`), o update, o audit e o evento
  // vivem no núcleo compartilhado com a rota e as tools MCP.
  const gravado = await atualizarInterfaceDaOrganizacao(supabase, activeOrg.orgId, parsed.data, activeOrg.role, {
    actorUserId: authUser.id,
    requestId,
    ip,
    userAgent,
  });
  if (!gravado.ok) return gravado;

  revalidatePath("/app/settings/tenant");
  // O menu vive no layout do /app: sem isto quem acabou de escolher continuaria
  // vendo o menu antigo até o próximo carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
