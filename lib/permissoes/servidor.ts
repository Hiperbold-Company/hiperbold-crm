/**
 * PERMISSÕES POR PERFIL — o portão de rota.
 *
 * `exigirPermissao(chave, opts)` é `requireRole` com uma pergunta a mais:
 *
 *  1. `requireRole(<menor papel liberável da chave>)` — autenticação, suporte
 *     encerrado, organização ativa de fonte confiável, organização suspensa,
 *     papel efetivo do banco (`fn_user_role_in_org`) e MFA continuam onde
 *     sempre estiveram. O piso é o MENOR que a capacidade pode ter, então quem
 *     está abaixo dele leva o mesmo `forbidden_role` de antes.
 *  2. O papel efetivo está no conjunto que a organização escolheu? `admin`
 *     passa sempre. As permissões vêm de `org.permissoes`, que
 *     `loadAuthUser` leu do banco NESTA requisição e já resolveu
 *     (`resolverPermissoes`, nunca lança): ausente = padrão do catálogo, que é
 *     exatamente o comportamento de antes desta feature.
 *
 * Recusa = 403 `forbidden_permission`, com a frase para a pessoa, e audit
 * `authz.denied` com `reason: "permission"` e a chave.
 *
 * Só o caminho de SESSÃO passa por aqui. Rotas com token `dsk_…`
 * (`resolveAuthDual`) aplicam isto no ramo de sessão e mantêm o do token como
 * era: o token tem o próprio teto (`role:<papel>` + escopo) e não é uma pessoa
 * com perfil na organização.
 */
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole, type RoleCheck } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

import { capacidade, pisoDaPermissao, type ChaveDePermissao } from "./catalogo";
import { papelPode } from "./resolver";

export interface OpcoesDaPermissao {
  requestId?: string;
  /** `resource_type` do audit `authz.denied`. */
  resource?: string;
}

/** A frase da recusa, por capacidade. Chave do dicionário (pt-BR → es). */
export const MENSAGEM_SEM_PERMISSAO =
  "Seu perfil não tem permissão para isto nesta organização. Peça a um administrador para liberar em Equipe › Permissões.";

export async function exigirPermissao(
  chave: ChaveDePermissao,
  opts: OpcoesDaPermissao = {},
): Promise<RoleCheck> {
  const authz = await requireRole(pisoDaPermissao(chave), opts);
  if (!authz.ok) return authz;

  const { org, user } = authz;
  if (papelPode(org.role, chave, org.permissoes)) return authz;

  // Fire-and-forget, como em `requireRole`: falha de audit alerta, não bloqueia o 403.
  void audit({
    action: "authz.denied",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: opts.resource ?? null,
    requestId: opts.requestId,
    metadata: { reason: "permission", permission: chave, effective_role: org.role },
  });
  return {
    ok: false,
    response: fail("forbidden_permission", traduzir(MENSAGEM_SEM_PERMISSAO, user.idioma), 403, {
      requestId: opts.requestId,
      details: { permission: chave, rotulo: capacidade(chave).rotulo },
    }),
  };
}
