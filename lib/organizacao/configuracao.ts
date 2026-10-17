/**
 * Os dados da ORGANIZAÇÃO que um administrador edita — dados da empresa, "o que a
 * empresa faz" e as portas do menu — num único lugar.
 *
 * Quem chama: as server actions de Configurações › Empresa
 * (`updateTenant`, `atualizarPerfilDaEmpresa`, `atualizarInterfaceDaEmpresa`), a
 * rota `GET/PATCH /api/v1/settings/organizacao` e as tools MCP de organização.
 * Todas escrevem pelas MESMAS funções daqui.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere o seu portão antes (admin +
 * MFA na action; `role:admin` + `mcp:write` no token — token não tem segundo
 * fator, ver `lib/api/auth-dual-admin.ts`) e entrega a organização já resolvida
 * de fonte confiável. O cliente recebido é SEMPRE o admin (a única policy de
 * escrita de `organizations` é de platform admin, issue #144) e todo UPDATE
 * filtra `organization_id`.
 */
import { audit } from "@/lib/audit";
import { paisesOferecidos } from "@/lib/legal/perfil-do-pais";
import { interfaceTemDestino, type InterfaceSettings } from "@/lib/navigation/interface";
import type { Role } from "@/lib/auth/types";
import type { TenantInput } from "@/lib/schemas/settings";
import type { createAdminClient } from "@/lib/supabase/admin";

/** O cliente de serviço — escrever em `organizations` pela sessão casa zero linhas (issue #144). */
type ClienteAdmin = ReturnType<typeof createAdminClient>;

export interface AutorDaOrganizacao {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type ResultadoDaOrganizacao = { ok: true } | { ok: false; error: string };

export interface ConfiguracaoDaOrganizacao {
  display_name: string;
  legal_name: string;
  cnpj: string | null;
  country: string | null;
  timezone: string;
  locale: string;
  currency: string;
  media_retention_days: number;
  dpo_email: string | null;
  privacy_policy_url: string | null;
  o_que_faz: string | null;
  interface_settings: unknown;
}

const COLUNAS =
  "display_name, legal_name, cnpj, country, timezone, locale, currency, media_retention_days, dpo_email, privacy_policy_url, onboarding_state, interface_settings";

export async function lerConfiguracaoDaOrganizacao(
  admin: ClienteAdmin,
  organizationId: string,
): Promise<ConfiguracaoDaOrganizacao | null> {
  const { data, error } = await admin
    .from("organizations")
    .select(COLUNAS)
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  const { onboarding_state, ...resto } = data as unknown as Record<string, unknown> & {
    onboarding_state: { welcome?: { o_que_faz?: string } } | null;
  };
  return {
    ...(resto as unknown as Omit<ConfiguracaoDaOrganizacao, "o_que_faz">),
    o_que_faz: onboarding_state?.welcome?.o_que_faz ?? null,
  };
}

function metaDoAudit(autor: AutorDaOrganizacao) {
  return {
    actorUserId: autor.actorUserId ?? null,
    actorApiTokenId: autor.actorApiTokenId ?? null,
    requestId: autor.requestId ?? null,
    ip: autor.ip ?? null,
    userAgent: autor.userAgent ?? null,
  };
}

async function emitirOrgAtualizada(admin: ClienteAdmin, organizationId: string, requestId: string | null | undefined) {
  await admin
    .rpc("emit_event", {
      p_event_type: "org.updated",
      p_entity_kind: "organization",
      p_entity_id: organizationId,
      p_payload: { organization_id: organizationId },
      p_metadata: { request_id: requestId ?? null },
      p_organization_id: organizationId,
    })
    .then(({ error: e }) => {
      if (e) console.error("[organizacao] emit_event failed", e.message);
    });
}

/**
 * Dados da empresa (`updateTenant`). `dados` já passou por `tenantSchema` (inteiro) ou por
 * `tenantSchema.pick(...)` (só as chaves enviadas): grava e audita SÓ as chaves presentes.
 * Antes o PATCH parcial regravava as dez colunas com o valor lido e auditava as dez como
 * alteradas, e um valor antigo inválido (CNPJ legado, por exemplo) travava qualquer outra edição.
 */
export async function atualizarDadosDaEmpresa(
  admin: ClienteAdmin,
  organizationId: string,
  dados: Partial<TenantInput>,
  autor: AutorDaOrganizacao,
): Promise<ResultadoDaOrganizacao> {
  // O país só entra se tiver PERFIL REVISADO (issue #1033): é a lista que o
  // seletor mostra, e é ela que a gravação confere — nem por API entra país sem lei revisada.
  const pais = dados.country ?? null;
  if ("country" in dados && pais !== null && !paisesOferecidos().some((p) => p.codigo === pais)) {
    return { ok: false, error: `País sem perfil revisado: ${pais}` };
  }

  const COLUNAS_DA_EMPRESA = [
    "display_name",
    "legal_name",
    "cnpj",
    "country",
    "timezone",
    "locale",
    "currency",
    "media_retention_days",
    "dpo_email",
    "privacy_policy_url",
  ] as const;
  const NULAVEIS = new Set<string>(["cnpj", "country", "dpo_email", "privacy_policy_url"]);
  const patch: Record<string, unknown> = {};
  for (const coluna of COLUNAS_DA_EMPRESA) {
    if (!(coluna in dados)) continue;
    const valor = (dados as Record<string, unknown>)[coluna];
    patch[coluna] = valor === undefined && NULAVEIS.has(coluna) ? null : valor;
  }
  const alteradas = Object.keys(patch);
  if (alteradas.length === 0) return { ok: true };

  const { error } = await admin.from("organizations").update(patch).eq("id", organizationId);
  if (error) return { ok: false, error: error.message };

  await audit({
    action: "org.updated",
    ...metaDoAudit(autor),
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: { fields_changed: alteradas },
  });
  await emitirOrgAtualizada(admin, organizationId, autor.requestId);
  return { ok: true };
}

/** "O que a empresa faz" (`atualizarPerfilDaEmpresa`), no mesmo lugar do onboarding. */
export async function atualizarPerfilDaOrganizacao(
  admin: ClienteAdmin,
  organizationId: string,
  oQueFaz: string,
  autor: AutorDaOrganizacao,
): Promise<ResultadoDaOrganizacao> {
  const { data: atual, error: erroDeLeitura } = await admin
    .from("organizations")
    .select("onboarding_state")
    .eq("id", organizationId)
    .maybeSingle<{ onboarding_state: Record<string, unknown> | null }>();
  if (erroDeLeitura || !atual) return { ok: false, error: "internal_error" };

  const estado = atual.onboarding_state ?? {};
  const welcome = (estado.welcome ?? {}) as Record<string, unknown>;
  const { error } = await admin
    .from("organizations")
    .update({ onboarding_state: { ...estado, welcome: { ...welcome, o_que_faz: oQueFaz } } })
    .eq("id", organizationId);
  if (error) return { ok: false, error: "internal_error" };

  await audit({
    action: "org.updated",
    ...metaDoAudit(autor),
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    // O texto livre NÃO entra no audit (append-only, retenção de 5 anos): só o nome do campo.
    metadata: { fields_changed: ["o_que_faz"] },
  });
  return { ok: true };
}

/** As portas do menu da empresa (`atualizarInterfaceDaEmpresa`). `settings` já passou pelo schema. */
export async function atualizarInterfaceDaOrganizacao(
  admin: ClienteAdmin,
  organizationId: string,
  settings: InterfaceSettings,
  papel: Role,
  autor: AutorDaOrganizacao,
): Promise<ResultadoDaOrganizacao> {
  // Recusa a seleção que deixaria a empresa sem NENHUMA área além das essenciais.
  if (!interfaceTemDestino(settings, papel)) return { ok: false, error: "sem_area" };

  const { error } = await admin
    .from("organizations")
    .update({ interface_settings: settings })
    .eq("id", organizationId);
  if (error) return { ok: false, error: "internal_error" };

  await audit({
    action: "org.interface_changed",
    ...metaDoAudit(autor),
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: { fields_changed: ["interface_settings"], interface_settings: settings },
  });
  // Mesmo TIPO de evento de `updateTenant`: um tipo novo não teria assinante.
  await emitirOrgAtualizada(admin, organizationId, autor.requestId);
  return { ok: true };
}
