/**
 * A porta comum das rotas `/api/v1/custom-fields` (migration 1015): papel (gerente lê, admin grava), organização e as
 * dependências do núcleo `lib/campos/administracao.ts`.
 *
 * Só SESSÃO (cookie): estas rotas não estão em `lib/auth/public-paths.ts`, então o bearer `dsk_…`
 * para no `proxy.ts`. Integração por token segue pela fachada antiga
 * (`/api/v1/pipelines/[id]/fields` e as tools MCP `crm_*_pipeline_field`), que já cria e altera na
 * mesma tabela. `organization_id` sai SEMPRE da sessão — nunca do corpo, da query nem do caminho.
 */
import type { DepsDasDefinicoes } from "@/lib/campos/administracao";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function entradaDosCampos(
  requestId: string,
  { escrita }: { escrita: boolean } = { escrita: false },
): Promise<{ ok: true; deps: DepsDasDefinicoes; t: (texto: string) => string } | { ok: false; response: Response }> {
  // LER é de gerente ou acima (a tela é de configuração; a ficha do atendente lê os campos pela
  // projeção em `settings.fields`). GRAVAR é de administrador — o MESMO piso da rota antiga
  // `/pipelines/[id]/fields` e das tools MCP `crm_*_pipeline_field`, que mexem na mesma tabela.
  const authz = await requireRole(escrita ? "admin" : "manager", { requestId, resource: "custom_field_definitions" });
  if (!authz.ok) return { ok: false, response: authz.response };
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  return {
    ok: true,
    t,
    deps: {
      // Service role com filtro manual de organização em TODA consulta do núcleo: o platform admin
      // em suporte não é membro da organização e a RLS o deixaria sem linha nenhuma.
      supabase: createAdminClient(),
      organizationId: authz.org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      papel: authz.org.role,
    },
  };
}
