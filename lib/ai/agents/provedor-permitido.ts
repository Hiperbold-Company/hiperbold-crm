/**
 * QUAL PROVEDOR E MODELO UMA VERSÃO DE AGENTE PODE USAR — a regra do servidor (20/10/2026).
 *
 * O formulário do agente só oferece (1) a chave do plano, "Chave própria do Hiperbold CRM
 * (OpenRouter)", com os modelos de `MODELOS_DA_INSTALACAO`, e (2) os provedores que a organização
 * CONECTOU com a própria chave. A tela esconde o resto, mas tela não é cerca: a API, a tool MCP e a
 * publicação passam por aqui, e é aqui que a recusa acontece (no salvar e no publicar).
 *
 * As regras:
 *  - `credential_id = null` ("a chave da instalação") só vale com provedor `openrouter` — a chave da
 *    instalação sai sempre por ela — e com modelo liberado em `MODELOS_DA_INSTALACAO`.
 *  - `credential_id` preenchido: a credencial tem de ser desta organização, estar ativa e ser do mesmo
 *    provedor da versão (a validação da chave em si continua sendo da publicação, em SQL).
 *  - A variante `:batch` da OpenRouter (Batch API, assíncrona) não conversa: nunca é aceita.
 *
 * `recusaDaChaveDaInstalacao` é pura (o publicar a usa; as credenciais ele já confere em SQL) e
 * `recusaDaVersao` acrescenta a conferência da credencial no salvar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehVarianteEmLote, modeloLiberado, PROVEDOR_DA_CHAVE_DA_INSTALACAO } from "@/lib/ai/modelos-da-instalacao";

export type CodigoDeRecusaDeProvedor = "provider_not_allowed" | "model_not_allowed";

export interface RecusaDeProvedor {
  code: CodigoDeRecusaDeProvedor;
  message: string;
}

export interface VersaoParaConferir {
  provider: string;
  model: string;
  credential_id: string | null;
}

export function recusaDaChaveDaInstalacao(
  v: VersaoParaConferir,
  lista: readonly string[],
): RecusaDeProvedor | null {
  if (ehVarianteEmLote(v.model)) {
    return {
      code: "model_not_allowed",
      message: `O modelo ${v.model} é a variante em lote (assíncrona) e não atende conversa. Escolha outro modelo.`,
    };
  }
  if (v.credential_id !== null) return null;
  if (v.provider !== PROVEDOR_DA_CHAVE_DA_INSTALACAO) {
    return {
      code: "provider_not_allowed",
      message:
        `${v.provider} não está disponível no seu plano: a chave do Hiperbold CRM sai pela OpenRouter. ` +
        "Escolha \"Chave própria do Hiperbold CRM (OpenRouter)\" ou conecte a sua chave em Configurações › IA.",
    };
  }
  if (!modeloLiberado(lista, v.model, v.provider)) {
    return {
      code: "model_not_allowed",
      message: `O modelo ${v.model} não está disponível no seu plano. Escolha um dos modelos liberados na chave do Hiperbold CRM.`,
    };
  }
  return null;
}

/** A regra pura mais a credencial: existe nesta organização, está ativa e é do provedor da versão. */
export async function recusaDaVersao(
  admin: SupabaseClient,
  organizationId: string,
  v: VersaoParaConferir,
  lista: readonly string[],
): Promise<RecusaDeProvedor | null> {
  const pura = recusaDaChaveDaInstalacao(v, lista);
  if (pura !== null || v.credential_id === null) return pura;

  const { data } = await admin
    .from("ai_provider_credentials")
    .select("provider, is_active")
    // Filtro por organização OBRIGATÓRIO: admin client ignora RLS e o id vem do corpo.
    .eq("organization_id", organizationId)
    .eq("id", v.credential_id)
    .maybeSingle();
  const c = data as { provider?: string; is_active?: boolean } | null;
  if (!c || c.is_active !== true || c.provider !== v.provider) {
    return {
      code: "provider_not_allowed",
      message:
        `${v.provider} não está conectado nesta empresa. Conecte a chave em Configurações › IA › ` +
        "\"Usar minha própria chave de IA (avançado)\" ou escolha a chave do Hiperbold CRM.",
    };
  }
  return null;
}
