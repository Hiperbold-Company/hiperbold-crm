/**
 * O SEAM DO PONTO — onde o System One encosta no resto do sistema.
 *
 * ═══ POR QUE ESTE LADO, E NÃO O `runModelCall` ═══
 *
 * O relatório em `docs/research/2026-09-19-jev-system-one-no-deskcomm.md` desenhou
 * um `runDecisionCall` espelhando `runModelCall`. Ao implementar, o repo corrigiu o
 * desenho: há DUAS pilhas, e o próprio `lib/ai/gateway-binding.ts` já documenta a
 * divisão — o seam do agente fala `pg.Pool`, e os workers do Next falam Supabase.
 *
 * O primeiro ponto a ser ligado (`sentiment_classify`, escolhido por rodar fora do
 * caminho crítico e por já falhar em silêncio por desenho) vive na pilha do Next.
 * Seguir o ponto onde ele está é mais honesto que arrastar o ponto até o desenho:
 * a versão `pg.Pool` nasce quando um ponto do agent-engine for ligado, e as duas
 * compartilham o cliente (`./cliente`), que é onde mora o contrato do fornecedor.
 *
 * ═══ O QUE ELE GARANTE ═══
 *
 *  1. **Sem credencial, nada sai da máquina.** A ausência é configuração, não
 *     incidente: o caminho atual assume no mesmo milissegundo, sem gastar
 *     requisição nem esperar timeout. "Credencial" é, nesta ordem: a da própria
 *     organização (BYOK), depois a da INSTALAÇÃO (`JEV_API_KEY`, decisão do dono
 *     do produto em 16/10/2026). A da instalação passa pelas MESMAS guardas da
 *     outra (interruptor, aceite da organização, tarefa não desligada): ter
 *     chave de reserva não é consentir.
 *  2. **O destino passa pela allowlist de egress** (F4-03), com o host vindo da
 *     config — nunca um `fetch` cru. Host fora dela falha FECHADO, como todo
 *     egress do runtime.
 *  3. **Nunca lança.** Egress bloqueado, fornecedor fora do ar, resposta ilegível:
 *     tudo chega a quem chamou como `{ ok: false, motivo }`.
 *
 * ═══ O QUE ELE NÃO FAZ ═══
 *
 * Fora o interruptor e a tarefa desligada (que são consentimento, não estratégia —
 * ver `chaveDaOrganizacao`), não decide se o fornecedor DEVE ser usado, e não conhece
 * o fallback. Isso é do call site, que é quem sabe o que fazer quando a resposta
 * não vem — e é por isso que o resultado é discriminado em vez de um valor com
 * default.
 */
import { allowlistedFetch, buildAllowlist } from "@/lib/agent-engine/edge/egress";
import { decifrarColunasDaCredencial } from "@/lib/ai/credenciais/cifra";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { baseDaApiDoJev, decidir, TETO_PADRAO_MS, type Pergunta, type ResultadoDaDecisao } from "./cliente";
import { lerConfigDoJev } from "./config";
import { chaveDaInstalacaoDoJev } from "./chave-da-instalacao";
import { PROVEDOR_DO_JEV, origemGravadaDoJev, type OrigemDaChaveDoJev, type OrigemGravadaDoJev } from "./credencial";
import { estadoEfetivoDaTarefa, TAREFAS_DO_JEV } from "./tarefas";

export interface EntradaDoPonto {
  /** O ponto de IA, como no registro (`lib/ai/pontos/registro.ts`). Vai à telemetria. */
  ponto: string;
  organizationId: string;
  estado: string | Record<string, unknown> | ReadonlyArray<unknown>;
  perguntas: Record<string, Pergunta>;
  tetoMs?: number;
}

/** A chave que sai para a rede e de quem ela é (vai a `llm_calls.origem_da_chave`). */
export interface ChaveDoJev {
  chave: string;
  origem: OrigemDaChaveDoJev;
}

/**
 * O que `decidirNoPonto` devolve: a decisão do cliente mais DE QUEM era a chave
 * (`null` = nenhuma saiu, não houve requisição). Nunca carrega a chave.
 */
export type ResultadoDoPonto = ResultadoDaDecisao & { origemDaChave: OrigemGravadaDoJev | null };

export interface DependenciasDoPonto {
  /**
   * Resolve a chave do fornecedor PARA AQUELA organização. `null` = não
   * configurado. Quando informado, SUBSTITUI a resolução inteira (credencial da
   * organização e reserva da instalação) — é a costura dos testes dos chamadores.
   */
  buscarChave?: (organizationId: string) => Promise<string | null>;
  /** A chave de reserva da instalação. Default: `JEV_API_KEY`. Só os testes trocam. */
  chaveDaInstalacao?: () => string | null;
  fetchImpl?: typeof fetch;
  /** Base da API. Default: `baseDaApiDoJev()`. A allowlist deriva dela. */
  baseUrl?: string;
  /** Allowlist de egress. O default é o host da base. */
  hostsPermitidos?: readonly string[];
}

/**
 * A chave do Jev DAQUELA organização: a credencial `typesafe` ativa e validada
 * mais recente. Nunca a chave de outra organização — seria o contrário do BYOK.
 * (A reserva da INSTALAÇÃO é `resolverChaveDoJev`, abaixo; esta função segue
 * respondendo só pela própria organização.) A mesma regra, sobre linhas já
 * lidas, é `credencialEmUsoPeloJev` (`./credencial.ts`): mudar uma é mudar a outra.
 *
 * "Validada" é a convenção de todo leitor de chave do repo
 * (`lib/ai/gateway-binding.ts`): chave colada e ainda não conferida não sai
 * para a rede.
 *
 * **Só com a tarefa DAQUELE ponto rodando** (`estadoEfetivoDaTarefa`: o
 * interruptor ligado, o aceite do administrador cobrindo o alcance dela, e ela
 * não desligada). Cadastrar a chave não é consentir: sem esta guarda, colar a
 * chave em Credenciais já mandava cada mensagem recebida ao fornecedor
 * estrangeiro, sem ninguém ter ligado nada (LGPD). E desligar uma tarefa é
 * parar de mandar o que ELA manda, qualquer que seja o chamador. A guarda mora
 * AQUI, e não em cada chamador, porque todo caminho até a rede passa por esta
 * leitura. Ponto sem tarefa do Jev não manda nada. O interruptor é lido
 * primeiro: desligado é o estado de toda instalação, e custa uma consulta só.
 *
 * Nunca lança. Leitura que falha devolve `null` e o chamador segue pelo caminho
 * de sempre — mas deixa rastro, porque sem ele uma decifragem quebrada é
 * indistinguível de "não cadastrou a chave". O log leva só a CLASSE do erro: a
 * mensagem pode carregar material da credencial.
 */
export async function chaveDaOrganizacao(organizationId: string, ponto: string): Promise<string | null> {
  return (await resolverChaveDoJev(organizationId, ponto, { comReservaDaInstalacao: false }))?.chave ?? null;
}

/**
 * A chave do Jev para a rede, na ordem decidida em 16/10/2026:
 *
 *  1. a credencial `typesafe` ativa e validada DA ORGANIZACAO (`origem:
 *     credencial_da_organizacao`) — vence sempre;
 *  2. a chave da INSTALAÇÃO, `JEV_API_KEY` (`origem: chave_da_instalacao`) —
 *     só quando a organização não tem uma utilizável (nenhuma, ou a decifragem
 *     da dela quebrou);
 *  3. `null` — nada sai.
 *
 * A guarda por tarefa (interruptor, aceite, tarefa não desligada) vale ANTES das
 * duas: a reserva da instalação não dispensa o consentimento da organização.
 * Leitura de banco que falha antes de a guarda ser conferida devolve `null` sem
 * reserva — sem saber se a organização consentiu, nada sai.
 *
 * Nunca lança, e o log leva só a classe do erro.
 */
export async function resolverChaveDoJev(
  organizationId: string,
  ponto: string,
  opcoes: { chaveDaInstalacao?: () => string | null; comReservaDaInstalacao?: boolean } = {},
): Promise<ChaveDoJev | null> {
  const tarefa = TAREFAS_DO_JEV.find((t) => t.ponto === ponto);
  if (!tarefa) return null;
  let propria: string | null = null;
  try {
    // Admin client passa por cima da RLS: o filtro por organização é
    // PROGRAMÁTICO e obrigatório (CLAUDE.md, anti-pattern 10).
    const admin = createAdminClient();
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (orgErr) throw orgErr;
    if (estadoEfetivoDaTarefa(lerConfigDoJev(org?.settings), tarefa) === "desligada") return null;

    const { data, error } = await admin
      .from("ai_provider_credentials")
      .select("id, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", PROVEDOR_DO_JEV)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      try {
        propria = decifrarColunasDaCredencial(data, organizationId);
      } catch (erro) {
        logger.warn("chave do Jev não pôde ser lida; seguindo pelo caminho de sempre", {
          organizationId,
          erro: erro instanceof Error ? erro.name : typeof erro,
        });
      }
    }
  } catch (erro) {
    logger.warn("chave do Jev não pôde ser lida; seguindo pelo caminho de sempre", {
      organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
  if (propria !== null && propria.trim() !== "") {
    return { chave: propria, origem: "credencial_da_organizacao" };
  }
  if (opcoes.comReservaDaInstalacao === false) return null;
  const daInstalacao = (opcoes.chaveDaInstalacao ?? chaveDaInstalacaoDoJev)();
  if (daInstalacao === null || daInstalacao.trim() === "") return null;
  return { chave: daInstalacao.trim(), origem: "chave_da_instalacao" };
}

/** A busca da chave que não voltou dentro do teto. */
const CHAVE_ATRASADA = Symbol("chave_atrasada");

/**
 * O teto (`tetoMs`, ou `TETO_PADRAO_MS` do cliente) é UM prazo para a busca da
 * chave e a chamada ao fornecedor juntas. Antes ele cobria só a chamada: com o
 * banco lento pelo PostgREST (duas leituras pelo cliente admin), o turno
 * esperava a leitura inteira e só então armava o relógio — e a leitura lenta
 * nunca contava como falha no disjuntor. Agora a leitura que estoura o prazo é
 * o Jev que não respondeu a tempo (`provedor_indisponivel`), e o que sobrar do
 * prazo é o teto da chamada.
 */
export async function decidirNoPonto(
  entrada: EntradaDoPonto,
  deps: DependenciasDoPonto = {},
): Promise<ResultadoDoPonto> {
  const buscarChave: (org: string) => Promise<ChaveDoJev | null> = deps.buscarChave
    ? async (org) => {
        const injetada = await deps.buscarChave!(org);
        return injetada === null ? null : { chave: injetada, origem: "credencial_da_organizacao" };
      }
    : (org) => resolverChaveDoJev(org, entrada.ponto, { chaveDaInstalacao: deps.chaveDaInstalacao });
  const teto = entrada.tetoMs ?? TETO_PADRAO_MS;
  const inicio = Date.now();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<typeof CHAVE_ATRASADA>((resolver) => {
    relogio = setTimeout(() => resolver(CHAVE_ATRASADA), teto);
  });
  // `chaveDaOrganizacao` nunca rejeita; a injetada, no teste, pode — e rejeitada
  // ela é "sem chave", como uma leitura que falha.
  const resolvida = await Promise.race([buscarChave(entrada.organizationId).catch(() => null), prazo]);
  clearTimeout(relogio);
  if (resolvida === CHAVE_ATRASADA) {
    return {
      ok: false,
      motivo: "provedor_indisponivel",
      exigeAcao: false,
      defeitoNosso: false,
      status: null,
      origemDaChave: null,
    };
  }
  if (resolvida === null || resolvida.chave.trim() === "") {
    return {
      ok: false,
      motivo: "sem_credencial",
      exigeAcao: false,
      defeitoNosso: false,
      status: null,
      origemDaChave: null,
    };
  }
  const { chave, origem } = resolvida;

  const base = deps.baseUrl ?? baseDaApiDoJev();
  const allowlist = buildAllowlist([...(deps.hostsPermitidos ?? [base])]);
  const fetchContido: typeof fetch = (input, init) =>
    allowlistedFetch(
      typeof input === "string" || input instanceof URL ? input : input.url,
      init,
      { allowlist, fetchImpl: deps.fetchImpl, log: logger },
    );

  const resultado = await decidir(
    {
      chave,
      estado: entrada.estado,
      perguntas: entrada.perguntas,
      // O que sobrou do prazo — o turno espera, no máximo, o teto inteiro.
      tetoMs: Math.max(1, teto - (Date.now() - inicio)),
    },
    { fetchImpl: fetchContido, baseUrl: base },
  );
  // Grava a origem própria do Jev, que não debita a carteira (migration 0960).
  return { ...resultado, origemDaChave: origemGravadaDoJev(origem) };
}
