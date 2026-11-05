/**
 * DE ONDE VEM A CHAVE QUE INDEXA E CONSULTA O SEU MATERIAL.
 *
 * ## O defeito que este arquivo existe para acabar
 *
 * `lib/ai/embed.ts` lia `AI_GATEWAY_API_KEY`/`OPENAI_API_KEY` do `process.env` e
 * mais nada. Ou seja: **cadastrar a chave da OpenAI pela tela não habilitava a
 * base de conhecimento.** Só editar o `.env` da instalação habilitava.
 *
 * Isso é pior do que parece, porque o produto PROMETE o contrário em dois
 * lugares que a pessoa lê antes de tentar:
 *
 *  - `lib/ai/pontos/provedores.ts` descreve a OpenAI como *"necessário para
 *    transcrever áudio e **para indexar o seu material**"*;
 *  - o painel `/app/ai/providers` lista `embedding_indexar` e
 *    `embedding_consultar` entre os pontos de IA da organização.
 *
 * Tela que oferece e motor que ignora é o anti-pattern que este repo mais
 * persegue. E o desfecho era mudo: sem chave o worker devolvia
 * `skipped: openai_key_missing`, o drain tratava `skipped` como sucesso, e a
 * linha da fonte continuava dizendo `status='ready'` para sempre.
 *
 * ## A escada, do mais específico ao mais genérico
 *
 *  1. **Binding do ponto** (`ai_purpose_bindings`) — a escolha explícita feita
 *     no painel de provedores. É a superfície que o operador enxerga, então ela
 *     vence.
 *  2. **Credencial OpenAI da organização** (`ai_provider_credentials`, ativa e
 *     validada). É o degrau que faz "cadastrei a chave na tela e funcionou"
 *     virar verdade sem exigir que ninguém entenda o que é um binding.
 *  3. **Credencial OpenRouter da organização.** Vem DEPOIS da OpenAI de
 *     propósito: a chave OpenRouter costuma estar cadastrada para a CONVERSA, e
 *     subi-la acima da OpenAI trocaria em silêncio o fornecedor (e a conta que
 *     paga) de quem já indexava com a OpenAI na atualização.
 *  4. **Chave da instalação** (`OPENROUTER_API_KEY`) — a que paga a conta de todas
 *     as empresas. Sai SEMPRE pela OpenRouter (`POST /api/v1/embeddings`, mesmo
 *     modelo `openai/text-embedding-3-small`, 1536 dimensões), nunca direto pela
 *     OpenAI nem pelo gateway da Vercel, mesmo com `OPENAI_API_KEY` no servidor
 *     (decisão do dono, 20/10/2026). Doc: https://openrouter.ai/docs/api-reference/embeddings/create-embeddings
 *  5. **Credencial Google da organização** — por último: quem só tem a chave do
 *     Google passa a ter base, e quem já indexava com a OpenAI não troca de
 *     fornecedor numa atualização.
 *  6. Nada. E "nada" é uma resposta legítima que o chamador precisa saber
 *     mostrar, não um erro para engolir.
 *
 * ## A escada só percorre os degraus da FAMÍLIA da base
 *
 * A família (OpenAI ou Google) decide o modelo, e o modelo decide se a busca
 * acha alguma coisa. Por isso ela NÃO pode sair da credencial que aparece
 * primeiro: uma organização só com a chave do Google indexava pelo degrau 7, e
 * no dia em que alguém cadastrava uma chave da OpenAI o degrau 2 passava a
 * valer — a pergunta saía com o outro modelo, a busca filtrava por ele e
 * devolvia zero trechos, sem erro e sem nada na fila (revisão do #1864).
 *
 * A família é, nesta ordem (`familiaDaBase`):
 *  1. **A escolha gravada** em `organizations.settings.base_de_conhecimento.familia`
 *     — só a troca explícita da tela (`PUT /api/v1/ai/knowledge/provedor`) a
 *     escreve, e essa troca refaz a base;
 *  2. **o modelo com que a base FOI indexada** (`embedding_model` da versão
 *     ativa mais recente) — o que a organização já tem gravado sem ter escolhido;
 *  3. nenhuma: as duas leituras DERAM CERTO e não há escolha nem base — só
 *     então a escada inteira vale. A primeira indexação fixa a família pelo item 2.
 *
 * Leitura que FALHA não é "nenhuma": `familiaDaBase` lança
 * `FamiliaDaBaseIlegivelError`. Tratar o erro como "sem família" recriava o
 * defeito pela porta dos fundos: uma passada do indexador com o banco
 * soluçando descia a escada, ativava uma versão com o modelo da OUTRA família,
 * e essa versão — a mais recente — passava a decidir a família dali em diante.
 *
 * Com a família fixada, cadastrar ou remover credencial não a troca. Se a chave
 * dela sumir, a resposta é `null` — a tela diz qual família ficou sem chave
 * (`lib/ai/embeddings/estado.ts`), e nunca se cai na outra calado.
 *
 * A decisão devolve a ORIGEM junto com a chave. Não é enfeite: é o que permite
 * a tela responder *"está usando a chave X **porque**…"* em vez de deixar o dono
 * do negócio adivinhando por que a indexação não anda.
 *
 * ## O modelo NÃO é escolha solta — é consequência do provedor
 *
 * OpenAI (direta, gateway ou OpenRouter) indexa com `text-embedding-3-small`;
 * Google indexa com `gemini-embedding-001`. Os dois em 1536 dimensões — o Google
 * a pedido (`outputDimensionality`, `lib/ai/embed.ts`) —, então a coluna
 * `ai_chunks.embedding vector(1536)` serve aos dois sem migration.
 *
 * Indexação e busca são coordenadas de um mesmo mapa: trocar só um lado não dá
 * erro nenhum — o agente simplesmente para de achar o seu conteúdo. Por isso a
 * versão de índice grava com que modelo foi calculada
 * (`ai_knowledge_versions.embedding_model`), a busca filtra por ele, e trocar de
 * provedor (`PUT /api/v1/ai/knowledge/provedor`) refaz a base inteira.
 */
import type { OrigemDaChaveLlm } from "@/lib/agent-engine/edge/llm/credentials";
import { decifrarColunasDaCredencial } from "@/lib/ai/credenciais/cifra";
import { OPENROUTER_BASE_URL } from "@/lib/ai/gateway";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Os dois pontos de IA que consomem embedding (`lib/ai/pontos/registro.ts`). */
export type PontoDeEmbedding = "embedding_indexar" | "embedding_consultar";

/** Pin de contrato: o mesmo modelo dos dois lados, com a mesma dimensão. */
export const MODELO_DE_EMBEDDING = "openai/text-embedding-3-small";
export const MODELO_DE_EMBEDDING_DO_GOOGLE = "google/gemini-embedding-001";
export const DIMENSOES_DO_EMBEDDING = 1536;

/** Quem prepara a base, do ponto de vista de quem escolhe na tela. */
export type ProvedorDaBase = "openai" | "google";

/** O modelo é função do provedor: OpenAI direta, gateway e OpenRouter dão o mesmo vetor. */
export function modeloDeEmbedding(provedor: ChaveDeEmbedding["provedor"]): string {
  return provedor === "google" ? MODELO_DE_EMBEDDING_DO_GOOGLE : MODELO_DE_EMBEDDING;
}

export function provedorDaBase(chave: Pick<ChaveDeEmbedding, "provedor">): ProvedorDaBase {
  return chave.provedor === "google" ? "google" : "openai";
}

export interface FamiliaDaBase {
  familia: ProvedorDaBase;
  /** `escolha` = gravada pela troca da tela; `indice` = lida do modelo da versão ativa. */
  origem: "escolha" | "indice";
}

/**
 * A leitura da família falhou. Quem AGE (indexar, consultar, trocar) falha
 * FECHADO: sem a família, qualquer degrau da escada pode ser da outra.
 */
export class FamiliaDaBaseIlegivelError extends Error {
  readonly code = "familia_da_base_ilegivel";
  constructor(
    readonly organizationId: string,
    motivo: string,
  ) {
    super(`Não consegui ler com que provedor a base de conhecimento é preparada: ${motivo}`);
    this.name = "FamiliaDaBaseIlegivelError";
  }
}

/**
 * A família com que a base desta organização é preparada, ou `null` quando as
 * leituras deram certo e ainda não há base nem escolha (ver o cabeçalho). Lança
 * `FamiliaDaBaseIlegivelError` quando uma leitura falha. Admin client com
 * filtro de organização programático.
 */
export async function familiaDaBase(organizationId: string): Promise<FamiliaDaBase | null> {
  const admin = createAdminClient();
  const { data: org, error: erroDaOrg } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (erroDaOrg) throw new FamiliaDaBaseIlegivelError(organizationId, erroDaOrg.message);
  const gravada = (org as { settings?: { base_de_conhecimento?: { familia?: unknown } } } | null)
    ?.settings?.base_de_conhecimento?.familia;
  if (gravada === "openai" || gravada === "google") return { familia: gravada, origem: "escolha" };

  const { data: versao, error: erroDaVersao } = await admin
    .from("ai_knowledge_versions")
    .select("embedding_model")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .not("embedding_model", "is", null)
    .order("activated_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (erroDaVersao) throw new FamiliaDaBaseIlegivelError(organizationId, erroDaVersao.message);
  const modelo = (versao as { embedding_model?: unknown } | null)?.embedding_model;
  if (typeof modelo !== "string") return null;
  return {
    familia: modelo === MODELO_DE_EMBEDDING_DO_GOOGLE ? "google" : "openai",
    origem: "indice",
  };
}

const NOME_DA_FAMILIA: Record<ProvedorDaBase, string> = { openai: "OpenAI", google: "Google" };

export type OrigemDaChave =
  | "binding_do_ponto"
  | "credencial_da_organizacao"
  | "chave_da_instalacao";

/**
 * A origem da chave de embedding no vocabulário de `llm_calls.origem_da_chave`
 * (0906, carteira de tokens; D-057), que só conhece DE QUEM é a chave:
 *
 *  - `binding_do_ponto` e `credencial_da_organizacao`: a chave é uma linha de
 *    `ai_provider_credentials` DA PRÓPRIA organização (as duas leituras deste
 *    arquivo filtram `organization_id`), a que o cliente cadastrou. Nunca debita.
 *  - `chave_da_instalacao`: a chave vem do `.env` da
 *    instalação (`OPENROUTER_API_KEY`), a que a Hiperbold
 *    paga. É a origem que debita, quando o peso do ponto for maior que zero
 *    (hoje `embedding_indexar` e `embedding_consultar` pesam 0).
 *
 * `Record` e não `switch`: um degrau novo da escada em `OrigemDaChave` quebra a
 * compilação aqui, em vez de cair em silêncio numa das duas origens.
 */
const ORIGEM_NO_VOCABULARIO_DE_LLM_CALLS: Record<OrigemDaChave, OrigemDaChaveLlm> = {
  binding_do_ponto: "credencial_da_organizacao",
  credencial_da_organizacao: "credencial_da_organizacao",
  chave_da_instalacao: "chave_da_instalacao",
};

export function origemDaChaveParaLlmCalls(origem: OrigemDaChave): OrigemDaChaveLlm {
  return ORIGEM_NO_VOCABULARIO_DE_LLM_CALLS[origem];
}

/**
 * O provedor REAL por onde a chamada de embedding sai, no que `llm_calls.provider`
 * grava (D-053 item 3). O modelo é fixo (`text-embedding-3-small`, da OpenAI),
 * mas o provedor que atende nem sempre é a OpenAI:
 *
 *  - pela chave da instalação: `openrouter`;
 *  - por endereço próprio (`baseUrl`, o do binding do painel): `custom`, o mesmo
 *    rótulo que o painel usa para "compatível com OpenAI, endereço seu". O
 *    endereço em si NÃO vai para a telemetria: pode carregar credencial;
 *  - direto na OpenAI (credencial da própria organização): `openai`.
 */
export function provedorDoEmbedding(
  chave: Pick<ChaveDeEmbedding, "provedor" | "baseUrl" | "origem">,
): string {
  if (chave.provedor === "openrouter") return "openrouter";
  if (chave.provedor === "google") return "google";
  if (chave.provedor === "gateway") return "gateway";
  if (chave.baseUrl) return "custom";
  return "openai";
}

export const EXPLICACAO_DA_ORIGEM: Record<OrigemDaChave, string> = {
  binding_do_ponto: "Escolhida por você no painel de Provedores.",
  credencial_da_organizacao: "Usando uma chave da organização cadastrada em Credenciais.",
  chave_da_instalacao: "Usando a chave de IA da instalação (OpenRouter).",
};

export interface ChaveDeEmbedding {
  /** Plaintext. Vive só no escopo de quem chamou — nunca logada nem persistida. */
  apiKey: string | null;
  /** `null` = falar direto com a OpenAI, quando não houver gateway. */
  baseUrl: string | null;
  provedor: "openai" | "openrouter" | "gateway" | "google";
  /** Quando true, a chamada vai pelo gateway (o SDK lê a chave do process.env). */
  viaGateway: boolean;
  origem: OrigemDaChave;
  /** Rótulo da credencial, quando houver — a tela mostra qual chave está valendo. */
  rotulo: string | null;
  /** Incoerências que não impedem a chamada mas alguém precisa ver. */
  avisos: string[];
}

/**
 * Resolve a chave de embedding da organização, ou `null` quando não há nenhuma.
 *
 * `organizationId` é obrigatório: um resolvedor que aceitasse organização
 * opcional acabaria chamado sem ela justamente no caminho que mais importa,
 * aplicando a configuração de ninguém.
 *
 * `familia` restringe a escada a uma família: omitida, vale a da base
 * (`familiaDaBase`); `null`, nenhuma restrição. A tela e a troca a passam para
 * perguntar "a OUTRA família teria chave?" antes de oferecer o botão.
 *
 * Com `familia` omitida, propaga `FamiliaDaBaseIlegivelError`: é ação, e ação
 * sem família não escolhe chave.
 */
export async function resolverChaveDeEmbedding(
  organizationId: string,
  ponto: PontoDeEmbedding = "embedding_indexar",
  opcoes: { familia?: ProvedorDaBase | null } = {},
): Promise<ChaveDeEmbedding | null> {
  const avisos: string[] = [];
  const familia =
    opcoes.familia !== undefined
      ? opcoes.familia
      : ((await familiaDaBase(organizationId))?.familia ?? null);

  // 1 · A escolha explícita do painel — se for da família da base.
  const binding = await lerBindingDeEmbedding(ponto, organizationId);
  if (binding?.credential_id) {
    const credencial = await decifrarCredencial(binding.credential_id, organizationId);
    if (credencial && familia !== null && provedorDaBase(credencial) !== familia) {
      avisos.push(
        `O painel de Provedores aponta para este ponto uma chave que a base de conhecimento não usa: ` +
          `a base é preparada com ${NOME_DA_FAMILIA[familia]}. Para mudar, troque o provedor na tela de Conhecimento.`,
      );
    } else if (credencial) {
      if (binding.model_id && !/embed/i.test(binding.model_id)) {
        // Falha ABERTA na informação: a chamada segue com o modelo do contrato,
        // e quem configurou fica sabendo que o campo dele não é obedecido.
        avisos.push(
          `O painel aponta "${binding.model_id}" para este ponto, mas o modelo de embedding é fixo ` +
            `(${modeloDeEmbedding(credencial.provedor)}) — trocá-lo exigiria reindexar todo o material de uma vez.`,
        );
      }
      return {
        apiKey: credencial.apiKey,
        baseUrl:
          credencial.provedor === "google"
            ? null
            : (binding.base_url ??
              (credencial.provedor === "openrouter" ? OPENROUTER_BASE_URL : null)),
        provedor: credencial.provedor,
        viaGateway: false,
        origem: "binding_do_ponto",
        rotulo: credencial.rotulo,
        avisos,
      };
    } else {
      avisos.push(
        "A chave escolhida no painel de Provedores para este ponto não está utilizável " +
          "(desativada, apagada ou ainda não validada). Seguindo com a próxima chave disponível.",
      );
    }
  }

  const daOrganizacao = (
    credencial: NonNullable<Awaited<ReturnType<typeof credencialDaOrganizacao>>>,
  ): ChaveDeEmbedding => {
    if (credencial.quantas > 1) {
      avisos.push(
        `Esta organização tem ${credencial.quantas} chaves ${credencial.provedor} cadastradas e nenhuma escolhida para ` +
          `a base de conhecimento. Usando "${credencial.rotulo}" — desative as excedentes em Credenciais para não depender da ordem.`,
      );
    }
    return {
      apiKey: credencial.apiKey,
      baseUrl: credencial.provedor === "openrouter" ? OPENROUTER_BASE_URL : null,
      provedor: credencial.provedor,
      viaGateway: false,
      origem: "credencial_da_organizacao",
      rotulo: credencial.rotulo,
      avisos,
    };
  };

  if (familia !== "google") {
    // 2 · Credencial OpenAI da organização, sem exigir binding nenhum.
    const openAiDaOrg = await credencialDaOrganizacao(organizationId, "openai");
    if (openAiDaOrg) return daOrganizacao(openAiDaOrg);

    // Sem gateway da Vercel nem `OPENAI_API_KEY` da instalação: a chave da
    // instalação sai SEMPRE pela OpenRouter (decisão do dono, 20/10/2026).
    //
    // 3 · Credencial OpenRouter da organização — só depois da OpenAI, para a
    // atualização não trocar o fornecedor de quem já indexava.
    const openRouterDaOrg = await credencialDaOrganizacao(organizationId, "openrouter");
    if (openRouterDaOrg) return daOrganizacao(openRouterDaOrg);

    // 4 · A chave da INSTALAÇÃO, sempre pela OpenRouter.
    if (env.OPENROUTER_API_KEY) {
      return {
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
        provedor: "openrouter",
        viaGateway: false,
        origem: "chave_da_instalacao",
        rotulo: null,
        avisos,
      };
    }
  }

  // 5 · Credencial Google da organização — só quando não há nenhuma via OpenAI.
  if (familia !== "openai") {
    const googleDaOrg = await credencialDaOrganizacao(organizationId, "google");
    if (googleDaOrg) return daOrganizacao(googleDaOrg);
  }

  return null;
}

/**
 * Existe chave utilizável para esta organização?
 *
 * Substitui `isEmbeddingProviderConfigured()`, cuja assinatura SEM organização
 * é a raiz do defeito: ela respondia "não" para toda organização que tivesse
 * cadastrado a chave pela tela.
 */
export async function temChaveDeEmbedding(organizationId: string): Promise<boolean> {
  try {
    return (await resolverChaveDeEmbedding(organizationId)) !== null;
  } catch (err) {
    if (!(err instanceof FamiliaDaBaseIlegivelError)) throw err;
    // Isto é INFORMAÇÃO (a resposta de quem acabou de cadastrar material), não
    // ação: falha aberta, "há alguma chave?". Quem indexa é o worker, que falha
    // fechado e tenta de novo.
    return (
      (await resolverChaveDeEmbedding(organizationId, "embedding_indexar", { familia: null })) !==
      null
    );
  }
}

/** As credenciais da organização que sabem gerar embedding. */
type ProvedorDeCredencial = "openai" | "openrouter" | "google";

function ehProvedorDeCredencial(p: unknown): p is ProvedorDeCredencial {
  return p === "openai" || p === "openrouter" || p === "google";
}

// ---------------------------------------------------------------------------
// Leitura do banco — admin client, filtro de organização SEMPRE programático
// (o service role bypassa RLS; CLAUDE.md, anti-pattern 10).
// ---------------------------------------------------------------------------

interface LinhaDeBinding {
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBindingDeEmbedding(
  ponto: PontoDeEmbedding,
  organizationId: string,
): Promise<LinhaDeBinding | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_purpose_bindings")
      .select("credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", ponto)
      .eq("is_enabled", true)
      .maybeSingle();
    return (data as LinhaDeBinding | null) ?? null;
  } catch (err) {
    // Tabela ausente (clone sem o baseline aplicado) não pode derrubar a
    // indexação — mas também não pode passar em silêncio.
    logger.warn("[embedding] não consegui ler o binding do ponto", {
      organization_id: organizationId,
      purpose: ponto,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function decifrarCredencial(
  credentialId: string,
  organizationId: string,
): Promise<{ apiKey: string; rotulo: string; provedor: ProvedorDeCredencial } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id, provider, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data || !ehProvedorDeCredencial(data.provider)) return null;
    return {
      apiKey: decifrarColunasDaCredencial(data, organizationId),
      rotulo: String((data as { label?: string }).label ?? ""),
      provedor: data.provider,
    };
  } catch {
    // Sem detalhe no log: qualquer eco aqui corre o risco de carregar material
    // da credencial.
    return null;
  }
}

/**
 * A credencial ativa e validada da organização, OpenAI, OpenRouter ou Google.
 *
 * Desempate DETERMINÍSTICO pela mais antiga: com duas chaves e nenhuma escolha,
 * "a mais recente" faria o comportamento mudar sozinho no dia em que alguém
 * cadastrasse outra. A tela de Credenciais deixa desativar as excedentes; aqui o que
 * importa é não variar.
 */
async function credencialDaOrganizacao(
  organizationId: string,
  provedor: ProvedorDeCredencial,
): Promise<{
  apiKey: string;
  rotulo: string;
  quantas: number;
  provedor: ProvedorDeCredencial;
} | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", provedor)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true });

    const linhas = (data ?? []) as Array<{
      id: string;
      label: string;
      api_key_encrypted: unknown;
      api_key_iv: unknown;
      api_key_tag: unknown;
    }>;
    const primeira = linhas[0];
    if (!primeira) return null;

    return {
      apiKey: decifrarColunasDaCredencial(primeira, organizationId),
      rotulo: primeira.label,
      quantas: linhas.length,
      provedor,
    };
  } catch {
    return null;
  }
}
