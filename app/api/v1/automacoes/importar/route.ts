import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/automacoes/importar — cria uma automação a partir de um arquivo
 * `hiperbold-automacao` v1 (`lib/automacoes/portabilidade.ts`). Dois passos, a
 * mesma rota:
 *
 *   1. `{ arquivo, previa: true }` → confere o arquivo e devolve o resumo e, para
 *      cada referência, as opções DESTA organização e a sugestão por nome. Não
 *      escreve nada.
 *   2. `{ arquivo, nome?, escolhas: { <referência>: <id daqui> } }` → confere tudo
 *      de novo, troca as referências pelos ids escolhidos e cria a automação como
 *      RASCUNHO (desligada). Aceita `Idempotency-Key`.
 *
 * Arquivo inválido é recusado inteiro, antes de qualquer escrita. A organização
 * vem da sessão (ou do token), nunca do arquivo; toda escolha tem de ser uma linha
 * ativa desta organização e do tipo da referência. Auth: sessão OU `dsk_…`, `manager`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { comIdempotencia, chaveDaRequisicao, identidadeDoAtor } from "@/lib/api/idempotency";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import {
  TAMANHO_MAXIMO_DA_AUTOMACAO,
  lerArquivoDeAutomacao,
  montarGrafoImportado,
  previaDaImportacao,
  type ArquivoDeAutomacao,
  type ReferenciaDoArquivo,
} from "@/lib/automacoes/portabilidade";
import { catalogoDaConta } from "@/lib/automacoes/portabilidade-db";
import { criarFluxo, type DepsDeFollowup } from "@/lib/followup/administracao";
import { MAX_FOLLOWUP_FLOW_NAME } from "@/lib/followup/nome-da-copia";
import { entradaDeFluxo } from "@/lib/followup/porta";
import { nomeDoImportado } from "@/lib/followup/portabilidade";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/automacoes/importar";
/** O arquivo vai dentro do corpo: folga para o envelope e as escolhas. */
const TETO_DO_CORPO = TAMANHO_MAXIMO_DA_AUTOMACAO + 64 * 1024;
/** Id de uma automação que ainda não existe — só para conferir antes de criar. */
const ID_PROVISORIO = "00000000-0000-4000-8000-ffffffffffff";

const corpoSchema = z.strictObject({
  arquivo: z.unknown(),
  previa: z.boolean().optional(),
  nome: z.string().trim().min(1).max(MAX_FOLLOWUP_FLOW_NAME).optional(),
  escolhas: z.record(z.string().max(40), z.string().uuid()).optional(),
});
type Corpo = z.infer<typeof corpoSchema>;

const recusa = (deps: DepsDeFollowup, status: number, code: string, msg: string, details?: Record<string, unknown>) =>
  new ApiError(status, code, details, deps.requestId, (deps.t ?? ((x: string) => x))(msg));

const FRASE_DO_ARQUIVO = "O arquivo não é uma automação válida. Confira os itens abaixo e tente de novo.";
const FRASE_DA_FALHA = "Não consegui importar a automação. Tente de novo.";

async function criar(
  deps: DepsDeFollowup,
  arquivo: ArquivoDeAutomacao,
  usadas: ReferenciaDoArquivo[],
  corpo: Corpo,
): Promise<{ id: string; name: string }> {
  const catalogo = await catalogoDaConta(deps.admin, deps.organizationId);
  const escolhas = corpo.escolhas ?? {};
  const conferida = montarGrafoImportado(arquivo, usadas, escolhas, catalogo, ID_PROVISORIO);
  if (!conferida.ok) {
    if (conferida.faltam.length > 0) {
      throw recusa(
        deps,
        422,
        "referencias_pendentes",
        "Escolha, para cada item da lista, o que corresponde nesta conta.",
        { faltam: conferida.faltam },
      );
    }
    throw recusa(deps, 422, "arquivo_invalido", FRASE_DO_ARQUIVO, { problemas: conferida.problemas });
  }

  const { data: existentes, error: nomesErr } = await deps.admin
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", deps.organizationId);
  if (nomesErr) throw recusa(deps, 500, "internal_error", FRASE_DA_FALHA);
  const nome = nomeDoImportado(
    corpo.nome ?? arquivo.automacao.nome,
    (existentes ?? []).map((r) => String((r as { name: string }).name)),
  );

  const criado = await criarFluxo(deps, { name: nome, surface: "automacao" });
  const montada = montarGrafoImportado(arquivo, usadas, escolhas, catalogo, criado.id);
  const { error: upErr } = montada.ok
    ? await deps.admin
        .from("followup_flow_pointers")
        .update({ draft_graph: montada.grafo })
        .eq("id", criado.id)
        .eq("organization_id", deps.organizationId)
    : { error: { message: "montagem_falhou" } };
  if (upErr || !montada.ok) {
    await deps.admin
      .from("followup_flow_pointers")
      .delete()
      .eq("id", criado.id)
      .eq("organization_id", deps.organizationId);
    throw recusa(deps, 500, "internal_error", FRASE_DA_FALHA);
  }
  void audit({
    action: "automacao.importada",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId: deps.requestId,
    // Contagens, nunca o texto das caixas nem os nomes das referências.
    metadata: {
      formato_versao: arquivo.versao,
      caixas: montada.grafo.nodes.length,
      ligacoes: montada.grafo.edges.length,
      referencias: usadas.length,
    },
  });
  return { id: criado.id, name: nome };
}

/**
 * Lê o corpo parando no teto, mesmo sem `content-length` (envio em partes): o
 * `req.text()` leria tudo para a memória antes de qualquer conferência.
 * Devolve `null` quando passa do teto.
 */
async function lerComTeto(req: Request, teto: number): Promise<string | null> {
  if (!req.body) return "";
  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > teto) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  const junto = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    junto.set(p, pos);
    pos += p.byteLength;
  }
  return new TextDecoder().decode(junto);
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeFluxo(req, { escrita: true, role: "manager" });
  if (e.resposta) return e.resposta;
  const { deps, requestId } = e;
  const t = deps.t ?? ((x: string) => x);
  const grandeDemais = () =>
    fail("payload_too_large", t("Arquivo grande demais para uma automação (máximo de 512 KB)."), 413, { requestId });

  if (Number(req.headers.get("content-length") ?? "0") > TETO_DO_CORPO) return grandeDemais();
  let texto: string | null;
  try {
    texto = await lerComTeto(req, TETO_DO_CORPO);
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  if (texto === null) return grandeDemais();
  let raw: unknown;
  try {
    raw = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const corpo = corpoSchema.safeParse(raw);
  if (!corpo.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: corpo.error.flatten() });
  }
  // O texto inteiro já cabe no teto do corpo; o arquivo sozinho tem o dele. Fundo demais (pilha) vira 422.
  let leitura: ReturnType<typeof lerArquivoDeAutomacao>;
  try {
    if (JSON.stringify(corpo.data.arquivo ?? null).length > TAMANHO_MAXIMO_DA_AUTOMACAO) return grandeDemais();
    leitura = lerArquivoDeAutomacao(corpo.data.arquivo);
  } catch {
    leitura = { ok: false, problemas: ["automacao.grafo: o arquivo tem aninhamento demais"] };
  }
  if (!leitura.ok) {
    return fail("arquivo_invalido", t(FRASE_DO_ARQUIVO), 422, {
      requestId,
      details: { problemas: leitura.problemas },
    });
  }

  try {
    if (corpo.data.previa) {
      const catalogo = await catalogoDaConta(deps.admin, deps.organizationId);
      return ok(previaDaImportacao(leitura.arquivo, leitura.usadas, catalogo), { requestId });
    }
    const chave = chaveDaRequisicao(req);
    if (chave === null) {
      return ok(await criar(deps, leitura.arquivo, leitura.usadas, corpo.data), { requestId, status: 201 });
    }
    const desfecho = await comIdempotencia({
      db: createAdminClient(),
      organizationId: deps.organizationId,
      endpoint: ENDPOINT,
      chave,
      ator: identidadeDoAtor(deps.actor),
      corpo: corpo.data,
      executar: async () => ({
        resposta: await criar(deps, leitura.arquivo, leitura.usadas, corpo.data),
        status: 201,
      }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma criação ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { requestId, status: desfecho.status as 200 | 201 });
  } catch (err) {
    if (err instanceof ApiError) return respostaDeRecusa(err, requestId);
    logger.error("automacao_importar_falhou", { requestId, err: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", t(FRASE_DA_FALHA), 500, { requestId });
  }
}
