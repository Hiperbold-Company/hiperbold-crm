/**
 * Os limites efetivos do plano de uma organização, com o cache CURTO da
 * cadeia de autorização (`lib/auth/cache-curto.ts`, 30 s) (D-227).
 *
 * ═══ Para quem ═══
 *
 * As travas dos limites novos que moram em caminho QUENTE: o `/api/mcp`
 * (`mcp_req_min`), o bearer `dsk_` da API REST (`acesso_api`) e o webhook de
 * entrada (`fonte_dados_req_min`). Ali `planoDaOrganizacao` a cada chamada
 * seriam duas leituras de banco por requisição de integração. Tela e criação
 * de coisa continuam chamando `planoDaOrganizacao` direto.
 *
 * ═══ A janela ═══
 *
 * Troca de plano (subir ou descer) leva até 30 s para valer nestas portas no
 * processo que já tinha a entrada. A entrada leva a etiqueta da organização,
 * então `invalidarOrg(orgId)` a derruba na hora no mesmo processo.
 *
 * ═══ Falha de leitura NÃO é cacheada ═══
 *
 * `planoDaOrganizacao` nunca lança; com o banco ruim devolve `leituraFalhou:
 * true`. Esse resultado não fica guardado (`guardar`): erro é incidente, não
 * estado, e cachear faria uma oscilação de 1 s virar 30 s de "plano sem MCP".
 * Quem chama decide o que `leituraFalhou` significa para a sua trava.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { comCacheCurto, etiquetaDeOrg } from "@/lib/auth/cache-curto";
import type { Logger } from "@/lib/agent-engine/obs/logger";

import type { Limites } from "./limites";
import { planoDaOrganizacao } from "./plano-da-organizacao";

export interface LimitesDaOrganizacao {
  limites: Limites;
  leituraFalhou: boolean;
}

export async function limitesComCacheCurto(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<LimitesDaOrganizacao> {
  return comCacheCurto<LimitesDaOrganizacao>({
    chave: `plano:limites:${organizationId}`,
    etiquetas: [etiquetaDeOrg(organizationId)],
    guardar: (v) => !v.leituraFalhou,
    carregar: async () => {
      const r = await planoDaOrganizacao(admin, organizationId, log);
      return { limites: r.limites, leituraFalhou: r.leituraFalhou };
    },
  });
}
