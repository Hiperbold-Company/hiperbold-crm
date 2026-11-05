"use server";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";
import {
  atualizarBloqueioAteAssumirDaOrganizacao,
  atualizarInterfaceDaOrganizacao,
} from "@/lib/organizacao/configuracao";

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
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // A guarda `sem_area`, a regra "o menu nunca grava a trava do Inbox" (#3012),
  // o `invalidarOrg` (#3696), o audit e o evento vivem no núcleo compartilhado com
  // a rota `PATCH /api/v1/settings/organizacao` e as tools MCP.
  const gravado = await atualizarInterfaceDaOrganizacao(
    createAdminClient(),
    activeOrg.orgId,
    parsed.data,
    activeOrg.role,
    await autorDaSessao(authUser.id),
  );
  return depoisDeGravar(gravado);
}

/**
 * Liga e desliga o bloqueio da caixa de mensagem até assumir (#3012), e SÓ ele.
 *
 * Irmã de `atualizarInterfaceDaEmpresa` com os mesmos gates: a trava mora em
 * `interface_settings`, mas o cartão do Inbox não pode mandar o retrato do menu
 * que leu na montagem — salvá-lo desfaria a escolha de menu feita depois. Lê o
 * gravado e troca só a chave. Desligar REMOVE a chave: ausente = desligado.
 */
export async function atualizarBloqueioAteAssumir(ligado: boolean): Promise<InterfaceDaEmpresaResult> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligado);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const gravado = await atualizarBloqueioAteAssumirDaOrganizacao(
    createAdminClient(),
    activeOrg.orgId,
    entrada.data,
    await autorDaSessao(authUser.id),
  );
  return depoisDeGravar(gravado);
}

/**
 * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — pelo mesmo motivo medido em
 * `updateTenant` (issue #144): a única policy de escrita da tabela é
 * `orgs_write_platform_admin`, então o UPDATE de um admin de organização pelo client
 * de sessão casa ZERO linhas e o PostgREST devolve sucesso. O gate continua sendo o
 * de cima (papel resolvido de fonte confiável) e o filtro por organização é
 * explícito — a organização vem da SESSÃO, nunca do corpo.
 */
async function autorDaSessao(actorUserId: string) {
  const hdrs = await headers();
  return {
    actorUserId,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
  };
}

function depoisDeGravar(gravado: InterfaceDaEmpresaResult): InterfaceDaEmpresaResult {
  if (!gravado.ok) return gravado;
  revalidatePath("/app/settings/tenant");
  // O menu vive no layout do /app: sem isto quem acabou de escolher continuaria
  // vendo o menu antigo até o próximo carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
