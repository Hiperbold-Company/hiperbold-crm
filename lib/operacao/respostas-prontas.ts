/**
 * ADMINISTRAR as respostas prontas (`message_templates`) — listar, criar, editar, apagar.
 *
 * Quem chama: as rotas `/api/v1/message-templates/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/administracao-fase3.ts`). A tela usa as mesmas rotas. A regra é uma só.
 *
 * ⚠️ DUAS PORTAS, DUAS RÉGUAS, UM SÓ RESULTADO:
 *  - **Sessão**: o cliente é o do usuário e a RLS (`message_templates_select/write`, migration 0060)
 *    decide — compartilhada de qualquer um, pessoal só do dono, escrever compartilhada só `manager`+.
 *    Os filtros daqui repetem a régua de propósito (defesa em profundidade) e nunca a afrouxam.
 *  - **Token**: o cliente é service role e BYPASSA a RLS. Uma chave de integração não é uma pessoa:
 *    não tem resposta pessoal. Por isso ela só LÊ, CRIA, EDITA e APAGA as COMPARTILHADAS
 *    (`owner_user_id is null`) — o `is null` é explícito em todo SELECT/UPDATE/DELETE, senão a chave
 *    leria e apagaria o rascunho pessoal de cada atendente da mesma empresa.
 *
 * ⚠️ `organization_id` é SEMPRE o que a porta resolveu (sessão/linha do token), nunca do corpo.
 * ⚠️ `created_by_user_id` tem FK em `auth.users`: quem chama passa a PESSOA (usuário da sessão ou
 * dono da chave), nunca o id do token.
 *
 * ─── Grupo, ordem e mídias (#3245, #3244, #2526) ───────────────────────────
 *
 * Valem para as duas portas, e por isso moram aqui e não na rota:
 *  - o GRUPO tem de ser da organização (`null` = sem grupo, sempre válido);
 *  - a lista sai na ORDEM que o operador escolheu (`ordem asc`), e a resposta nova nasce no TOPO,
 *    um passo acima da primeira visível, sem empate;
 *  - `midias` nunca entra pelo corpo da criação (nasce vazia; quem adiciona é a rota de upload, que
 *    confere os bytes). O PATCH só REMOVE: a lista nova tem de ser subconjunto da gravada, cada
 *    caminho tem de ser DESTE template e desta organização (o `storage.remove` roda por service role,
 *    sem RLS), e a gravação leva a lista lida como precondição (`eq midias`), a mesma de todo
 *    escritor da lista. O arquivo sai do bucket SÓ DEPOIS da linha gravada (ou apagada).
 */
import { isDeepStrictEqual } from "node:util";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { roleAtLeast } from "@/lib/auth/types";
import { logger } from "@/lib/logger";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import {
  snapshotDeMidiasSchema,
  type CreateTemplateInput,
  type UpdateTemplateInput,
} from "@/lib/schemas/templates";
import { grupoDaOrganizacao } from "@/lib/templates/grupo-da-resposta";
import { apagarMidiasDoTemplate } from "@/lib/templates/midias-no-bucket";
import { conferirMidias, midiaPertenceAoTemplate, type MidiaDeTemplate } from "@/lib/templates/midias";
import { posicaoEntre } from "@/lib/templates/ordem";

export const COLUNAS_DA_RESPOSTA_PRONTA =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, mostrar_na_barra, grupo_id, created_by_user_id, created_at, updated_at, ordem";

/** `t` traduz a frase de recusa para o idioma de quem chama (a rota passa o dela). */
export interface DepsDasRespostas extends DepsDaOperacao {
  t?: (texto: string) => string;
}

const tr = (deps: DepsDasRespostas) => deps.t ?? ((texto: string) => texto);

function recusa(
  deps: DepsDaOperacao,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(status, code, details, deps.requestId, message);
}

/** A pessoa, quando quem age é uma. Token e agente não têm resposta pessoal. */
function pessoa(deps: DepsDaOperacao): string | null {
  return deps.actor.type === "user" ? deps.actor.id : null;
}

/** O grupo (#3245) tem de ser da organização. A FK composta do banco é a segunda barreira. */
async function conferirGrupo(deps: DepsDasRespostas, grupoId: string | null | undefined, falha: string) {
  let valido: boolean;
  try {
    valido = await grupoDaOrganizacao(deps.supabase as never, deps.organizationId, grupoId);
  } catch {
    throw recusa(deps, 500, "internal_error", falha);
  }
  if (!valido) {
    throw recusa(deps, 422, "validation_failed", tr(deps)("Dados inválidos."), {
      grupo_id: [tr(deps)("Grupo que não pertence a esta organização.")],
    });
  }
}

export async function listarRespostasProntas(deps: DepsDaOperacao): Promise<unknown[]> {
  const dono = pessoa(deps);
  const base = deps.supabase
    .from("message_templates")
    .select(COLUNAS_DA_RESPOSTA_PRONTA)
    .eq("organization_id", deps.organizationId);
  const visiveis = dono === null ? base.is("owner_user_id", null) : base.or(`owner_user_id.is.null,owner_user_id.eq.${dono}`);
  // A ordem é a que o OPERADOR escolheu (`ordem`, #3244), não a de edição: com `updated_at desc`
  // editar o corpo de uma resposta a empurrava para o topo desta lista e do slash-menu do Inbox.
  // Dois desempates: duas que empatem (criadas ao mesmo tempo) saem mais recente primeiro.
  const { data, error } = await visiveis
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao listar templates.");
  return data ?? [];
}

export async function criarRespostaPronta(
  deps: DepsDasRespostas,
  entrada: CreateTemplateInput,
  responsavel: string | null,
): Promise<{ id: string } & Record<string, unknown>> {
  const { title, body, shortcut, shared, mostrar_na_barra, grupo_id } = entrada;
  const dono = pessoa(deps);

  if (dono === null && !shared) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      "Uma chave de API não tem resposta pessoal: envie shared=true para criar uma resposta compartilhada.",
    );
  }
  // A RLS with_check barra de qualquer forma na sessão; isto dá um erro claro antes do insert.
  if (shared && !roleAtLeast("role" in deps.actor ? deps.actor.role : undefined, "manager")) {
    throw recusa(deps, 403, "forbidden", tr(deps)("Só manager+ cria template compartilhado."));
  }

  await conferirGrupo(deps, grupo_id, "Erro ao criar template.");

  // A resposta nova nasce no TOPO e sem empate: um passo acima da primeira da lista visível. Com
  // todas nascendo na mesma posição, o desempate passava a ser `updated_at` — e editar uma resposta
  // nova voltava a reordenar a lista (o defeito da #3244 pela porta da criação). Na sessão a RLS
  // recorta o visível; a chave só vê as compartilhadas.
  let primeiraVisivel = deps.supabase
    .from("message_templates")
    .select("ordem")
    .eq("organization_id", deps.organizationId);
  if (dono === null) primeiraVisivel = primeiraVisivel.is("owner_user_id", null);
  const { data: primeira, error: erroPrimeira } = await primeiraVisivel
    .order("ordem", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (erroPrimeira) throw recusa(deps, 500, "internal_error", "Erro ao criar template.");
  const menor = (primeira as { ordem: number } | null)?.ordem ?? null;
  // `posicaoEntre(null, x)` nunca é `null`: só o empate entre DUAS vizinhas é.
  const ordem = posicaoEntre(null, menor)!;

  const { data, error } = await deps.supabase
    .from("message_templates")
    .insert({
      organization_id: deps.organizationId,
      owner_user_id: shared ? null : dono,
      title,
      body,
      shortcut: shortcut ?? null,
      // Ausente = `null` = lista plana, o estado de toda resposta anterior à 0808.
      grupo_id: grupo_id ?? null,
      // "Mostrar na barra do Inbox" (#3282): só vai quando quem chama escolheu; ausente, vale o
      // default da coluna (`true`).
      ...(mostrar_na_barra === undefined ? {} : { mostrar_na_barra }),
      // `midias` nasce vazia: a mídia entra pela rota de upload, que gera o caminho sabendo o id do
      // template e confere os bytes. Aceitar caminho aqui seria aceitar arquivo que ninguém conferiu.
      midias: [],
      created_by_user_id: responsavel,
      ordem,
    })
    .select(COLUNAS_DA_RESPOSTA_PRONTA)
    .single();
  if (error || !data) throw recusa(deps, 500, "internal_error", "Erro ao criar template.");

  const linha = data as unknown as { id: string } & Record<string, unknown>;
  void audit({
    action: "template.created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: linha.id,
    requestId: deps.requestId,
    metadata: { shared, title },
  });
  return linha;
}

export async function alterarRespostaPronta(
  deps: DepsDasRespostas,
  id: string,
  alteracao: UpdateTemplateInput,
): Promise<unknown> {
  const t = tr(deps);
  const chave = pessoa(deps) === null;

  // `undefined` não mexe no vínculo; `null` DESVINCULA (volta à lista plana).
  if (alteracao.grupo_id !== undefined) await conferirGrupo(deps, alteracao.grupo_id, "Erro ao atualizar template.");

  // A lista ATUAL vem antes do update: é dela que sai o diff. Sem esta leitura um PATCH que só
  // remove apagaria o arquivo errado — ou nenhum. Chave não é pessoa: só mexe no que é da empresa.
  let leitura = deps.supabase
    .from("message_templates")
    .select("midias")
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (chave) leitura = leitura.is("owner_user_id", null);
  const { data: linha, error: erroLeitura } = await leitura.maybeSingle();
  if (erroLeitura) {
    logger.error("[message-templates] falha ao ler midias", { detalhe: erroLeitura.message, requestId: deps.requestId });
    throw recusa(deps, 500, "internal_error", "Erro ao atualizar template.");
  }
  if (!linha) throw recusa(deps, 404, "not_found", t("Template não encontrado."));

  const atuais = ((linha as { midias?: MidiaDeTemplate[] | null }).midias ?? []) as MidiaDeTemplate[];
  const { midias_esperadas: esperadas, ...campos } = alteracao;
  if (!snapshotDeMidiasSchema.safeParse(atuais).success || (esperadas !== undefined && !isDeepStrictEqual(atuais, esperadas))) {
    throw recusa(deps, 409, "conflict", t("As mídias mudaram. Recarregue a página."));
  }
  const novas = campos.midias;
  let removidas: string[] = [];
  let mantidas: MidiaDeTemplate[] | undefined;
  if (novas !== undefined) {
    if (novas.some((m) => !midiaPertenceAoTemplate(m.storage_path, deps.organizationId, id))) {
      throw recusa(deps, 422, "validation_failed", t("Dados inválidos."), {
        midias: ["Imagem que não pertence a este template."],
      });
    }
    const conferida = conferirMidias(atuais, novas);
    // A tela está atrás da linha (outra aba mexeu) ou o corpo foi forjado.
    if (!conferida.ok) throw recusa(deps, 409, "conflict", t("As imagens mudaram. Recarregue a página."));
    removidas = conferida.removidas;
    mantidas = conferida.mantidas;
  }

  let escrita = deps.supabase
    .from("message_templates")
    // `midias` sai da LINHA conferida, nunca do corpo: o mime e o tamanho de cada imagem são do
    // upload que conferiu os bytes.
    .update(
      { ...campos, ...(mantidas ? { midias: mantidas } : {}), updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (chave) escrita = escrita.is("owner_user_id", null);
  const { data, error, count } = await Promise.resolve(
    escrita
      // Todos os escritores da lista usam a mesma precondição, inclusive o PATCH sem snapshot
      // esperado. O valor bruto é JSONB, não objeto implícito.
      .eq("midias", JSON.stringify(atuais))
      .select(COLUNAS_DA_RESPOSTA_PRONTA)
      .maybeSingle(),
  ).catch(() => ({ data: null, error: { message: "write_failed" }, count: null }));
  if (error || (!data && count !== 0)) {
    throw recusa(
      deps,
      500,
      "internal_error",
      t("Não foi possível confirmar a gravação. Recarregue a página antes de tentar de novo."),
    );
  }
  if (!data) throw recusa(deps, 409, "conflict", t("As mídias mudaram. Recarregue a página."));

  // Só depois da linha gravada, e nunca derruba o PATCH: o pedido (remover a imagem) já foi
  // atendido, o log é o que falta para a limpeza.
  const apagaveis = removidas.filter((caminho) => midiaPertenceAoTemplate(caminho, deps.organizationId, id));
  if (apagaveis.length) await apagarMidiasDoTemplate(apagaveis, deps.requestId);

  void audit({
    action: "template.updated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: (data as { id: string }).id,
    requestId: deps.requestId,
    metadata: { fields: Object.keys(campos), removidas: removidas.length },
  });
  return data;
}

export async function apagarRespostaPronta(deps: DepsDasRespostas, id: string): Promise<{ id: string }> {
  let consulta = deps.supabase
    .from("message_templates")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (pessoa(deps) === null) consulta = consulta.is("owner_user_id", null);
  // `.select()` confirma que a linha existia E era apagável: um DELETE barrado afeta 0 linhas e
  // não pode virar 204 + audit de uma exclusão que não houve. `midias` vem junto porque é a ÚLTIMA
  // chance de ler os caminhos: depois do delete a imagem ficaria órfã para sempre (#2526).
  const { data, error } = await consulta.select("id, midias").maybeSingle();
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao excluir template.");
  if (!data) throw recusa(deps, 404, "not_found", tr(deps)("Template não encontrado."));

  const apagada = data as { id: string; midias?: MidiaDeTemplate[] | null };
  const caminhos = (apagada.midias ?? [])
    .map((m) => m.storage_path)
    // A leitura do bucket é por service role e o apagado é irreversível: só o que é DESTE template.
    .filter((caminho) => midiaPertenceAoTemplate(caminho, deps.organizationId, id));
  await apagarMidiasDoTemplate(caminhos, deps.requestId);

  void audit({
    action: "template.deleted",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: apagada.id,
    requestId: deps.requestId,
    metadata: { midias: caminhos.length },
  });
  return { id: apagada.id };
}
