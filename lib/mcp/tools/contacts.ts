/**
 * MCP read tools sobre /api/v1/contacts (Spec 11 §3.1).
 *
 * Wrappa os handlers REST extraidos na wave 2 (S-13.02). O MCP server core
 * injeta `ctx.supabase` (admin client + service-role) e `ctx.organizationId`
 * — handlers ja aplicam `.eq('organization_id', ctx.organization_id)` em
 * defesa-em-profundidade pos wave 3 (RLS continua valida quando ctx vem
 * de cookie).
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  listContactsHandler,
  getContactHandler,
  patchContactHandler,
} from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";
import {
  chavesDisponiveis,
  converterValorDoCampoDoContato,
  lerCamposDaOrganizacao,
  TETO_DO_TEXTO_DO_CAMPO,
} from "@/lib/campos/campo-do-contato-pelo-agente";
import type { McpToolDefinition } from "../types";
import { CAMPOS_PROPONIVEIS, proporDadoDoContato } from "@/lib/contacts/proposta-de-dado";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { audit } from "@/lib/audit";
import { origemConfiavelDoNome, registrarNomeInformado } from "@/lib/contacts/nome-informado";
import { registrarNomeAplicadoNaTimeline } from "@/lib/contacts/telefone-aplicado";
import { currentExecutionJob, currentExecutionBoundary, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

/**
 * Os telefones da ficha para a IA (Spec 31, B1): o tipo e o WhatsApp do
 * principal, e os extras com a MESMA forma da API (`GET /api/v1/contacts/{id}`).
 * O cliente aqui é o administrador do MCP (service role, sem RLS): o filtro de
 * organização é explícito nas duas leituras, e `wa_lid` fica de fora.
 */
async function telefonesDaFichaParaIa(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
) {
  const { data: principal } = await supabase
    .from("contacts")
    .select("phone_type, phone_whatsapp")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  const { data: extras, error } = await supabase
    .from("contact_phones")
    .select("phone_number, tipo, whatsapp, rotulo, origem, created_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId);
  if (error) throw new Error(`contact_phones: ${error.message}`);
  // Ordenado por created_at na memória: a leitura é pequena (poucos números por
  // ficha) e a ordem fica explícita aqui, como na API.
  const ordenados = [...(extras ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    phone_type: principal?.phone_type ?? null,
    phone_whatsapp: principal?.phone_whatsapp ?? null,
    additional_phones: ordenados.map((e) => ({
      phone_number: e.phone_number,
      type: e.tipo,
      whatsapp: e.whatsapp,
      label: e.rotulo,
      origin: e.origem,
      created_at: e.created_at,
    })),
  };
}

const searchInputShape = {
  query: z.string().min(1).max(200).describe("Termo de busca (nome, email ou telefone)."),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmSearchContacts: McpToolDefinition<typeof searchInputShape> = {
  name: "crm_search_contacts",
  description:
    "Busca contatos do CRM por nome, email ou telefone. Retorna ate 50 matches com id, nome, telefone, email, tags e timestamps. Sempre escopado a organization do token." +
    " Em conversa de atendimento, devolve apenas o contato desta conversa.",
  inputSchema: searchInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const doTurno = ctx.contatoDoTurno;
    const result = await listContactsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        search: input.query,
        limit: input.limit,
        cursor: input.cursor,
      },
      // O escopo vai NA CONSULTA, antes do limite: filtrar a página depois
      // devolvia vazio quando o contato do turno não estava entre os primeiros
      // que casavam com o termo.
      doTurno,
    );

    // ── A CONVERSA É COM ALGUÉM (#2158) ─────────────────────────────────────
    //
    // A escrita já era escopada pelo contato do turno (`negocioDaEscritaDoTurno`);
    // a LEITURA não era — e esta é a que devolve telefone E e-mail numa resposta
    // só. Num atendimento com o cliente A, o modelo buscava "Maria" e recebia a
    // ficha da cliente B: audit gravando `success: true`, e o dado saía no
    // WhatsApp do outro lado, encaminhável, sem volta. Diferente da escrita, que
    // suja um cadastro e dá para corrigir, a leitura sai do prédio.
    //
    // ESCOPO, e não tradução: o termo continua sendo o que o modelo digitou, e
    // continua sendo o `listContactsHandler` que decide o que casa — muda só
    // QUEM a resposta alcança, e quem alcança é o contato desta conversa. É o
    // propósito declarado da ferramenta ("saber com quem está falando"), que o
    // runtime já sabe sem perguntar.
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA: nasce no runtime e é
    // injetado em `lib/ai/runtime/tools.ts` — o modelo não escreve esse campo.
    // Sem ele (rota HTTP, MCP externo, agente sem conversa), a busca segue
    // alcançando a base da organização, exatamente como antes. O Operador TEM
    // contato do turno (`operator-turn.ts` passa `job.contact_id`) e também
    // fica escopado — o lado seguro, porque ele não fala com o lead.
    //
    // A paginação morre junto: `cursor`/`has_more` descrevem a varredura da
    // ORGANIZAÇÃO, e a próxima página voltaria a ser varredura.
    const visiveis = doTurno ? result.contacts.filter((c) => c.id === doTurno) : result.contacts;

    return {
      contacts: visiveis.map((c) => ({
        id: c.id,
        name: nomeDoContato(c),
        phone: c.phone_number,
        email: c.email,
        tags: c.tags ?? [],
        is_blocked: c.is_blocked,
        is_anonymized: c.is_anonymized,
        // Espelha a coluna como os outros selos: a lista já exclui pessoais por
        // padrão (etapa 13), e este campo prova o elo coluna → ferramenta.
        is_personal: c.is_personal,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
      cursor: doTurno ? null : result.cursor,
      has_more: doTurno ? false : result.has_more,
    };
  },
};

const getInputShape = {
  contact_id: z.string().uuid().describe("UUID do contato."),
};

export const crmGetContact: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_contact",
  description:
    "Retorna detalhes de um contato pelo UUID. Inclui tags, consent, source. CPF nunca retornado em plaintext via MCP (sempre mascarado)." +
    " Em conversa de atendimento, devolve a ficha do contato desta conversa.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── A FICHA DE QUEM NÃO É DESTA CONVERSA NÃO ABRE AQUI (#2158) ──────────
    //
    // RECUSA, e não tradução: trocar o uuid pedido pelo do contato do turno
    // faria o modelo perguntar por um cliente e receber outro — a mesma razão
    // que `lib/ai/runtime/tools.ts` escreve para não trocar `lead_id` em
    // leitura. Escopar aqui seria trocar, e o pedido é de ficha, não de busca.
    //
    // O motivo vem em TEXTO, na mesma forma que `negocioDaEscritaDoTurno`
    // devolve ao modelo, para ele ler por que foi recusado e seguir a conversa
    // sem gastar turno numa exceção. `ctx.contatoDoTurno` é contexto de
    // CONFIANÇA (injetado pelo runtime, nunca escrito pelo modelo); sem ele —
    // rota HTTP, MCP externo, agente sem conversa — a ficha de qualquer
    // contato da organização segue abrindo como antes. O Operador recebe o
    // contato do turno e também é recusado aqui.
    if (ctx.contatoDoTurno && input.contact_id !== ctx.contatoDoTurno) {
      return {
        permitido: false,
        motivo: "fora_da_conversa",
        mensagem:
          "esta conversa é com outra pessoa — a ficha de um cliente que não é o desta conversa " +
          "não é sua para abrir; siga a conversa com quem está falando.",
      };
    }
    const contact = await getContactHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { contactId: input.contact_id, decryptPurpose: null },
    );
    // ── A FICHA DE PESSOAL NÃO SAI PELO MCP (spec 21, etapa 12) ─────────────
    //
    // RECUSA no tool, com motivo em texto para o modelo (molde do #2158 acima):
    // a ficha carrega telefone e e-mail, e pessoal está fora da operação. A
    // ficha da TELA continua abrindo — é nela que mora o botão desmarcar (D10).
    if (contact.is_personal === true) {
      return {
        permitido: false,
        motivo: "contato_pessoal",
        mensagem:
          "este contato foi marcado como pessoal — ele está fora da operação: a ficha " +
          "não é sua para abrir e nada se escreve para ele; siga a conversa com quem está falando.",
      };
    }
    const telefones = await telefonesDaFichaParaIa(ctx.supabase, ctx.organizationId, contact.id);
    return {
      id: contact.id,
      name: contact.name,
      display_name: contact.display_name,
      email: contact.email,
      phone: contact.phone_number,
      ...telefones,
      tags: contact.tags ?? [],
      source: contact.source,
      consent: contact.consent ?? {},
      is_blocked: contact.is_blocked,
      is_anonymized: contact.is_anonymized,
      is_personal: contact.is_personal,
      cpf_available: contact.cpf_available,
      created_at: contact.created_at,
      last_activity_at: contact.last_activity_at,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_propose_contact_field — o dado que o cliente disse, PROPOSTO
// ---------------------------------------------------------------------------

const propostaShape = {
  contact_id: z.string().uuid(),
  campo: z
    .enum(CAMPOS_PROPONIVEIS)
    .describe("Qual informação: email, name, phone_number ou birthdate (AAAA-MM-DD)."),
  valor: z.string().min(1).max(200).describe("O valor exatamente como a pessoa informou."),
  trecho: z
    .string()
    .max(500)
    .optional()
    .describe("O que a pessoa escreveu, para quem for confirmar poder conferir."),
};

/**
 * Proposta por padrão. As exceções de telefone vazio e nome vazio são opt-in.
 * O nome exige seleção semântica nesta tool, contexto inbound do servidor e
 * correspondência com a mensagem real. Isso não autentica identidade e não
 * torna o classificador infalível. Só o retorno aplicado autoriza dizer "salvo".
 *
 * ⚠️ O TEXTO NÃO PROMETE A GRAVAÇÃO: as duas opções são POR ORGANIZAÇÃO e
 * desligadas por padrão, e o nome ainda depende do turno real — quem lê a
 * ferramenta não pode decidir antes de chamá-la se o desfecho foi escrita ou
 * fila. Quem responde é o RETORNO (`motivo: "aplicado_automaticamente"`). Um
 * modelo que acredite ter gravado responderia "pronto, já atualizei seu
 * cadastro" prometendo o que não aconteceu; um que ache que nunca grava diria
 * "vou anotar para alguém confirmar" quando o dado já entrou na ficha.
 *
 * Ela é de CATÁLOGO, e não nativa do Operador, porque o Operador não monta
 * ToolSet nativo nenhum (zero ocorrências de `tool(` em operator-turn.ts) e só
 * chama o modelo quando há MCP. Uma nativa não apareceria na tela que liga
 * capacidades, não entraria no audit `mcp.tool_called` e sumiria da telemetria
 * de uso — nasceria invisível ao invariante 3 do sistema vivo.
 */
export const crmProposeContactField: McpToolDefinition<typeof propostaShape> = {
  name: "crm_propose_contact_field",
  description:
    "Registra uma informação fornecida pelo cliente como PROPOSTA para uma pessoa confirmar. " +
    "Use campo name somente quando a mensagem atual informar claramente o PRÓPRIO nome do cliente, " +
    "inclusive uma resposta direta à pergunta sobre seu nome. Não trate saudações, concordância, " +
    "negativas, pedidos, perguntas ou instruções como nomes, nem nome de outra pessoa. " +
    "Copie o nome informado, sem inventar ou completar. EXCEÇÕES com opção da organização ligada: " +
    "um TELEFONE para ficha SEM número pode ser gravado em E.164; um NOME de pelo menos duas partes " +
    "para ficha SEM nome pode ser gravado quando o servidor confirmar a mensagem real deste turno. " +
    "As opções vêm desligadas. Só o retorno motivo aplicado_automaticamente permite dizer que o cadastro " +
    "foi atualizado. Nome ou telefone preexistente diferente, email e nascimento exigem revisão humana. " +
    "Sem esse motivo no retorno, diga apenas que alguém vai conferir. Proposta já pendente ou contato " +
    "anonimizado pode impedir o registro.",
  inputSchema: propostaShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Nenhum id ou trecho do modelo confere autoridade: só o job/limite do runtime.
    const origemNome = input.campo === "name"
      ? origemConfiavelDoNome(ctx, input.contact_id, currentExecutionJob(), currentExecutionBoundary())
      : null;
    let textoOriginalDoNome: string | undefined;
    if (origemNome) {
      const nome = await registrarNomeInformado(getRequestPool(), origemNome, input.valor, guardServiceEffect);
      if (nome.aplicado) {
        // O rastro visível, como o do telefone: a auditoria gravada junto com o
        // nome não aparece na ficha. Nunca lança — o nome já está gravado.
        await registrarNomeAplicadoNaTimeline(ctx.supabase, {
          organizationId: ctx.organizationId,
          contactId: origemNome.contactId,
          nome: nome.nome,
          agentId: ctx.actor.type === "ai_agent" ? (ctx.actor.agent_id ?? null) : null,
        });
        return {
          proposta_criada: false,
          motivo: "aplicado_automaticamente",
          campo: "name",
          nome: nome.nome,
          mensagem: "O nome que a pessoa informou foi GRAVADO na ficha vazia deste contato; pode dizer que ficou anotado.",
        };
      }
      textoOriginalDoNome = nome.textoOriginal;
    }
    const r = await proporDadoDoContato(ctx.supabase, {
      organizationId: ctx.organizationId,
      contactId: input.contact_id,
      campo: input.campo,
      valor: input.valor,
      trecho: textoOriginalDoNome ?? input.trecho ?? null,
      ...(origemNome && textoOriginalDoNome !== undefined
        ? { conversationId: origemNome.conversationId, messageId: origemNome.messageId } : {}),
      // ⚠️ `agent_id`, NUNCA `actor.id`: a coluna `crm_lead_activities.actor_agent_id`
      // tem FK para `ai_agents`, e `actor.id` carrega o id do RUN (ou o do
      // token, ou a string `agent-engine` dependendo do runtime). Sem
      // `agent_id` a linha entra como sistema — perde-se a AUTORIA do rastro,
      // que é ruim, em vez da linha inteira, que é pior. Ver `Actor` em
      // `lib/api/handlers/types.ts`.
      agentId: ctx.actor.type === "ai_agent" ? (ctx.actor.agent_id ?? null) : null,
    });

    // Mesmo payload de ator das outras tools de escrita. Inline porque
    // `retencao.ts` mantém o dele local — extrair para um módulo comum tocaria
    // um arquivo alheio sem que este trabalho peça isso. Subiu para cima do
    // `if` porque o desfecho APLICADO também audita (#2593) e é o mesmo ator.
    const a =
      ctx.actor.type === "user"
        ? { actorUserId: ctx.actor.id as string | null, metadataActor: { actor_type: "user" } }
        : { actorUserId: null, metadataActor: { actor_type: ctx.actor.type, actor_id: ctx.actor.id } };

    if (!r.criada) {
      // ── #2593: o telefone de ficha vazia JÁ ESTÁ na ficha ──────────────────
      //
      // Este é o ÚNICO desfecho em que a mensagem pode ser repetida ao
      // cliente — ele aconteceu de verdade. Os de baixo continuam sendo do
      // fluxo interno, para o modelo decidir o que fazer em seguida.
      if (r.motivo === "aplicado_automaticamente") {
        await audit({
          action: "contact.field_auto_applied",
          actorUserId: a.actorUserId,
          organizationId: ctx.organizationId,
          resourceType: "contact",
          resourceId: input.contact_id,
          requestId: ctx.requestId,
          // Quem aplicou, quando e o par antes/depois da L-06 — SEM o `trecho`.
          // A auditoria não é alcançada pela anonimização (só sai pela retenção),
          // e o trecho é texto livre do cliente: numa clínica pode trazer dado de
          // saúde. Ele vai para a linha da timeline, que a cascata da LGPD limpa
          // (`registrarTelefoneAplicadoNaTimeline`).
          metadata: {
            ...a.metadataActor,
            campo: input.campo,
            old_value: null,
            new_value: r.telefone,
            automatico: true,
            legal_basis: "L-05 transactional (dado informado pelo titular em atendimento iniciado por ele)",
          },
        });
        return {
          proposta_criada: false,
          motivo: r.motivo,
          telefone: r.telefone,
          mensagem:
            "este contato estava SEM telefone e o número que a pessoa informou foi GRAVADO no cadastro, " +
            `em formato internacional (${r.telefone}); pode dizer ao cliente que ficou anotado. ` +
            "Um número que já existia no cadastro nunca é substituído por esta chamada.",
        };
      }

      // As mensagens são para o MODELO decidir o que fazer em seguida — e
      // nenhuma delas é para repetir ao cliente. Falam do fluxo interno, não do
      // atendimento.
      const explicacao: Record<string, string> = {
        contato_nao_encontrado: "não encontrei esse contato nesta conta.",
        contato_anonimizado:
          "esse contato exerceu o direito de exclusão de dados; não é possível registrar informações dele.",
        valor_invalido:
          "o valor não tem forma de email/telefone/nome/data de nascimento válidos — confirme com a pessoa.",
        valor_igual_ao_atual: "essa informação já está no cadastro; não há o que confirmar.",
        ja_existe_proposta:
          "já existe uma proposta desse mesmo campo aguardando decisão de uma pessoa — não crie outra.",
        erro: "não consegui registrar a proposta agora.",
      };
      return { proposta_criada: false, motivo: r.motivo, mensagem: explicacao[r.motivo] };
    }

    await audit({
      action: "contact.field_proposed",
      actorUserId: a.actorUserId,
      organizationId: ctx.organizationId,
      resourceType: "contact",
      resourceId: input.contact_id,
      requestId: ctx.requestId,
      // O par antes/depois desde a PROPOSTA, mesma grafia de `team.role_changed`.
      // A proposta é uma intenção auditável mesmo que nunca vire escrita.
      metadata: {
        ...a.metadataActor,
        proposal_id: r.id,
        campo: input.campo,
        old_value: r.valorAnterior,
        new_value: input.valor,
      },
    });

    return {
      proposta_criada: true,
      proposta_id: r.id,
      campo: input.campo,
      aguardando: "confirmação de uma pessoa",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_set_contact_custom_field — a resposta do cliente num campo DO CONTATO
// ---------------------------------------------------------------------------

/** Quantos campos numa chamada só: uma rodada de qualificação, não uma importação. */
const MAX_CAMPOS_POR_CHAMADA = 10;

const valorDoCampoShape = z.union([
  z.string().max(TETO_DO_TEXTO_DO_CAMPO * 2),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(30),
]);

const setCampoShape = {
  campos: z
    .record(z.string().min(1).max(40), valorDoCampoShape)
    .describe(
      "Mapa { chave: valor } com as respostas da pessoa. A chave é uma das listadas abaixo; em campo de " +
        "opção, mande o NOME da opção escolhida (ex.: { \"interesse\": \"Moradia\" }).",
    ),
};

/**
 * Uma fila por contato, neste processo: o handler LÊ o mapa, mescla e regrava
 * (o PATCH substitui `custom_fields`), e duas chamadas paralelas do mesmo turno
 * leriam o mesmo estado e a segunda apagaria a primeira. Escritas do mesmo
 * contato em sequência; contatos diferentes seguem em paralelo.
 */
const filaPorContato = new Map<string, Promise<unknown>>();
function emSequencia<T>(chave: string, operacao: () => Promise<T>): Promise<T> {
  const anterior = filaPorContato.get(chave) ?? Promise.resolve();
  const atual = anterior.then(operacao, operacao);
  const fim = atual.then(
    () => undefined,
    () => undefined,
  );
  filaPorContato.set(chave, fim);
  void fim.then(() => {
    if (filaPorContato.get(chave) === fim) filaPorContato.delete(chave);
  });
  return atual;
}

/** Iguais para gravar? Escalares por `===`, listas item a item. */
function mesmoValor(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

interface RecusaDeCampo {
  campo: string;
  motivo: string;
  mensagem: string;
}

/**
 * Grava campos personalizados do CONTATO desta conversa — o que uma automação
 * de qualificação fazia com "pergunta com botões → campo".
 *
 * O CONTATO NÃO É ARGUMENTO. Vem de `ctx.contatoDoTurno`, que só o runtime
 * injeta (`lib/ai/runtime/tools.ts`); sem ele (rota HTTP, MCP externo) a
 * ferramenta recusa. A organização vem do token, como em toda ferramenta. Não
 * há id para o modelo errar nem para um cliente mal-intencionado apontar.
 *
 * A ESCRITA É A DA FICHA: `patchContactHandler`, com o mapa INTEIRO mesclado
 * (as outras chaves ficam como estão). Por ele passam o bloqueio de contato
 * anonimizado, o padrão do campo (`padrao`), o evento `contact.updated` e a
 * auditoria `contact.updated` com o ator `ai_agent` — a mesma trilha de quem
 * edita na tela.
 */
export const crmSetContactCustomField: McpToolDefinition<typeof setCampoShape> = {
  name: "crm_set_contact_custom_field",
  description:
    "Grava, na ficha do CONTATO desta conversa, campos personalizados com o que a pessoa respondeu " +
    "(ex.: a opção que ela escolheu numa pergunta com botões). Só grave o que a pessoa disse ou escolheu, " +
    "nunca um palpite. Em campo de opção, use o nome de uma das opções listadas; o valor é conferido pelo " +
    "tipo do campo e o que não servir volta recusado, com o motivo. Campo do NEGÓCIO não é gravado aqui " +
    "(use crm_update_lead). O retorno `gravado: true` é o que permite dizer que ficou anotado.",
  inputSchema: setCampoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const contato = ctx.contatoDoTurno;
    if (!contato) {
      return {
        gravado: false,
        motivo: "sem_conversa",
        mensagem: "esta ferramenta só grava no contato de uma conversa em atendimento.",
      };
    }
    const entradas = Object.entries(input.campos ?? {});
    if (entradas.length === 0 || entradas.length > MAX_CAMPOS_POR_CHAMADA) {
      return {
        gravado: false,
        motivo: "quantidade_invalida",
        mensagem: `mande de 1 a ${MAX_CAMPOS_POR_CHAMADA} campos por chamada.`,
      };
    }

    const definicoes = await lerCamposDaOrganizacao(ctx.supabase, ctx.organizationId);
    if (definicoes === null) {
      return { gravado: false, motivo: "indisponivel", mensagem: "não consegui ler os campos agora; tente de novo." };
    }

    const validos: Record<string, unknown> = {};
    const recusados: RecusaDeCampo[] = [];
    for (const [chaveDoModelo, bruto] of entradas) {
      const alvo = chaveDoModelo.trim().toLowerCase();
      const campo = definicoes.find((d) => d.key.toLowerCase() === alvo);
      if (!campo) {
        recusados.push({
          campo: chaveDoModelo,
          motivo: "campo_inexistente",
          mensagem: `«${chaveDoModelo}» não é um campo do contato. Campos disponíveis: ${chavesDisponiveis(definicoes)}.`,
        });
        continue;
      }
      if (campo.entidade !== "contato") {
        recusados.push({
          campo: campo.key,
          motivo: "campo_do_negocio",
          mensagem: `«${campo.label}» é um campo do NEGÓCIO, não do contato: grave-o com crm_update_lead.`,
        });
        continue;
      }
      if (!campo.publico) {
        recusados.push({
          campo: campo.key,
          motivo: "campo_restrito",
          mensagem: `«${campo.label}» é restrito a administradores e não é preenchido pelo assistente.`,
        });
        continue;
      }
      const convertido = converterValorDoCampoDoContato(campo, bruto);
      if (!convertido.ok) {
        recusados.push({ campo: campo.key, motivo: convertido.motivo, mensagem: convertido.mensagem });
        continue;
      }
      validos[campo.key] = convertido.valor;
    }

    const comRecusas = (r: Record<string, unknown>) =>
      recusados.length > 0
        ? { ...r, campos_nao_gravados: recusados, erro_de_ensino: recusados.map((x) => x.mensagem).join(" ") }
        : r;

    if (Object.keys(validos).length === 0) {
      return comRecusas({ gravado: false, motivo: "nada_gravado" });
    }

    return emSequencia(JSON.stringify([ctx.organizationId, contato]), async () => {
      const { data: linha, error } = await ctx.supabase
        .from("contacts")
        .select("id, custom_fields, is_personal, is_anonymized")
        .eq("organization_id", ctx.organizationId)
        .eq("id", contato)
        .maybeSingle();
      if (error) {
        return comRecusas({ gravado: false, motivo: "indisponivel", mensagem: "não consegui ler a ficha agora." });
      }
      const ficha = linha as
        | { custom_fields: unknown; is_personal: boolean | null; is_anonymized: boolean | null }
        | null;
      if (!ficha) {
        return comRecusas({ gravado: false, motivo: "contato_nao_encontrado", mensagem: "não encontrei a ficha desta conversa." });
      }
      if (ficha.is_personal === true) {
        return comRecusas({
          gravado: false,
          motivo: "contato_pessoal",
          mensagem: "este contato foi marcado como pessoal — nada se escreve para ele; siga a conversa.",
        });
      }
      if (ficha.is_anonymized === true) {
        return comRecusas({
          gravado: false,
          motivo: "contato_anonimizado",
          mensagem: "esse contato exerceu o direito de exclusão de dados; não é possível registrar informações dele.",
        });
      }
      const atual =
        ficha.custom_fields && typeof ficha.custom_fields === "object" && !Array.isArray(ficha.custom_fields)
          ? (ficha.custom_fields as Record<string, unknown>)
          : {};
      const mudam = Object.entries(validos).filter(([k, v]) => !mesmoValor(atual[k], v));
      if (mudam.length === 0) {
        return comRecusas({ gravado: true, campos: validos, sem_mudanca: true });
      }
      try {
        await patchContactHandler(
          ctx.supabase,
          { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
          contato,
          { custom_fields: { ...atual, ...validos } },
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 422) {
          // O padrão do campo (`padrao`) recusou: a frase é a que o dono escreveu.
          return comRecusas({
            gravado: false,
            motivo: "fora_do_padrao",
            mensagem: `${err.message} Não grave assim: pergunte de novo à pessoa.`,
          });
        }
        if (err instanceof ApiError && err.status === 403) {
          return comRecusas({ gravado: false, motivo: "contato_anonimizado", mensagem: err.message });
        }
        throw err;
      }
      return comRecusas({ gravado: true, campos: validos });
    });
  },
};
