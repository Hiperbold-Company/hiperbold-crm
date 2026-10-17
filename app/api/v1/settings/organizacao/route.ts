import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/settings/organizacao — dados da empresa, "o que a empresa faz" e
 *                                      as portas do menu da organização.
 * PATCH /api/v1/settings/organizacao — grava o que vier (parcial) nesses três blocos.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. As escritas vivem em `lib/organizacao/configuracao.ts`,
 * o MESMO núcleo das server actions da tela (`updateTenant`,
 * `atualizarPerfilDaEmpresa`, `atualizarInterfaceDaEmpresa`) e das tools MCP, e o
 * corpo passa pelos MESMOS schemas (`tenantSchema`, `perfilDaEmpresaSchema`,
 * `interfaceSettingsSchema`).
 *
 * Auth: sessão OU token `dsk_…`. Escrita exige `admin` (como as actions) e, no
 * token, `role:admin` + `mcp:write`; leitura, `manager` + `mcp:read`.
 *
 * ⚠️ SEGUNDO FATOR: a action da tela barra quem tem a exigência de MFA ligada e
 * ainda não provou o fator. Token não tem sessão `aal2`, então aqui o limite de
 * confiança é a emissão da chave (só um admin cria `role:admin`, a chave
 * aparece uma vez, é revogável e morre com o criador). Ver
 * `lib/api/auth-dual-admin.ts`. A escrita em `organizations` vai pelo admin
 * client (a policy de escrita é só de platform admin, issue #144) e filtra
 * `organization_id` — que sai da sessão/da linha do token, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { atorDoAudit, autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { fail, ok } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { interfaceSettingsSchema } from "@/lib/navigation/interface";
import {
  atualizarDadosDaEmpresa,
  atualizarInterfaceDaOrganizacao,
  atualizarPerfilDaOrganizacao,
  lerConfiguracaoDaOrganizacao,
} from "@/lib/organizacao/configuracao";
import { perfilDaEmpresaSchema } from "@/lib/schemas/perfil-da-empresa";
import { tenantSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = tenantSchema
  .partial()
  .extend({
    o_que_faz: perfilDaEmpresaSchema.shape.o_que_faz.optional(),
    interface_settings: interfaceSettingsSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "organization",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const config = await lerConfiguracaoDaOrganizacao(createAdminClient(), authz.organizationId);
  if (!config) return fail("not_found", t("Organização não encontrada."), 404, { requestId });
  return ok(config, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "organization",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar na organização."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { o_que_faz: oQueFaz, interface_settings: interfaceSettings, ...dadosPedidos } = parsed.data;

  const admin = createAdminClient();
  const atual = await lerConfiguracaoDaOrganizacao(admin, authz.organizationId);
  if (!atual) return fail("not_found", t("Organização não encontrada."), 404, { requestId });

  const autor = {
    ...atorDoAudit(authz),
    requestId,
    ip: ipDoCliente(req.headers),
    userAgent: req.headers.get("user-agent"),
  };

  const falhou = (error: string) =>
    error === "sem_area"
      ? fail("unprocessable_entity", t("Selecione ao menos uma área além das essenciais."), 422, { requestId })
      : error.startsWith("País sem perfil revisado")
        ? fail("unprocessable_entity", error, 422, { requestId })
        : fail("internal_error", t("Não foi possível concluir agora. Tente novamente em instantes."), 500, { requestId });

  if (Object.keys(dadosPedidos).length > 0) {
    // Parcial → valida SÓ as chaves enviadas. Validar o conjunto final (atual + pedido) fazia um
    // valor antigo inválido, que ninguém estava mexendo, recusar a edição de outro campo.
    const mascara = Object.fromEntries(Object.keys(dadosPedidos).map((k) => [k, true])) as Record<
      keyof typeof dadosPedidos,
      true
    >;
    const completo = tenantSchema.pick(mascara).safeParse(dadosPedidos);
    if (!completo.success) {
      return fail("unprocessable_entity", t("Não entendi o que mudar na organização."), 422, {
        requestId,
        details: completo.error.flatten(),
      });
    }
    const r = await atualizarDadosDaEmpresa(admin, authz.organizationId, completo.data, autor);
    if (!r.ok) return falhou(r.error);
  }
  if (oQueFaz !== undefined) {
    const r = await atualizarPerfilDaOrganizacao(admin, authz.organizationId, oQueFaz, autor);
    if (!r.ok) return falhou(r.error);
  }
  if (interfaceSettings !== undefined) {
    const papel = authz.via === "token" ? "admin" : (authz.actor.type === "user" ? (authz.actor.role as "admin") : "admin");
    const r = await atualizarInterfaceDaOrganizacao(admin, authz.organizationId, interfaceSettings, papel, autor);
    if (!r.ok) return falhou(r.error);
  }

  const depois = await lerConfiguracaoDaOrganizacao(admin, authz.organizationId);
  return ok(depois, { requestId });
}
