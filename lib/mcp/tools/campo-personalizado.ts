/**
 * `crm_set_custom_field` — a resposta do cliente no campo personalizado certo.
 *
 * Quem decide ONDE o valor mora é a definição do campo
 * (`custom_field_definitions.entidade`), não a ferramenta:
 *
 *  - campo do CONTATO → `contacts.custom_fields` do contato da conversa, pela
 *    escrita da ficha (`patchContactHandler`);
 *  - campo do NEGÓCIO → `crm_leads.custom_fields` do negócio ABERTO desse
 *    contato, pelo mesmo caminho de `crm_update_lead` (conferência #2234 +
 *    `updateLeadHandler`, que mescla no banco e julga padrão e opção).
 *
 * O CONTATO NÃO É ARGUMENTO, e o negócio também não. O contato vem de
 * `ctx.contatoDoTurno`, que só o runtime injeta (`lib/ai/runtime/tools.ts`); sem
 * ele (rota HTTP, MCP externo) a ferramenta recusa. A organização vem do token,
 * como em toda ferramenta, e toda leitura filtra `organization_id`. O negócio é
 * o ÚNICO aberto do contato: com zero ou com vários, a recusa ensina e nada é
 * gravado — a mesma régua de `leadIdDoContatoDoTurno`, que não escolhe cartão
 * por palpite.
 *
 * ESCOPO DE FUNIL: a ponte não tem `lead_id` para julgar (a ferramenta é
 * `sem_funil` em `ALVO_DE_FUNIL`, porque gravar só no contato não toca funil).
 * Quem julga o negócio é este handler, com `podeOperarNoFunil` sobre
 * `ctx.funisDoTurno` — que a ponte injeta junto do contato. Ausente vale nenhum.
 *
 * SEM GRAVAÇÃO EM DOBRO: valor igual ao que já está gravado não escreve (nem
 * atividade, nem auditoria, nem evento), e escritas do mesmo alvo neste
 * processo passam em fila (`emSequencia`). SEM APAGAR O VIZINHO: as duas
 * escritas mesclam no banco (`fn_contato_anotar_campos`, `fn_lead_anotar_campos`),
 * nunca regravam o mapa que leram.
 */
import { z } from "zod";

import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";
import {
  chavesDisponiveis,
  converterValorDoCampo,
  lerCamposDaOrganizacao,
  TETO_DO_TEXTO_DO_CAMPO,
} from "@/lib/campos/campo-pelo-agente";
import type { EntidadeDoCampo } from "@/lib/campos/definicoes";
import { podeOperarNoFunil, recusaParaOModelo } from "@/lib/leads/escopo-de-funil";
import { conferirCamposPersonalizados } from "@/lib/mcp/conferencia-de-campos";

import type { McpContext, McpToolDefinition } from "../types";
import { crmUpdateLead } from "./leads";

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
 * Uma fila por alvo, neste processo: a ficha do contato é LIDA, mesclada e
 * regravada (o PATCH substitui `custom_fields`), e duas chamadas paralelas do
 * mesmo turno leriam o mesmo estado e a segunda apagaria a primeira. A
 * comparação "já está gravado?" do negócio também lê antes de escrever. Alvos
 * diferentes seguem em paralelo.
 */
const filaPorAlvo = new Map<string, Promise<unknown>>();
function emSequencia<T>(chave: string, operacao: () => Promise<T>): Promise<T> {
  const anterior = filaPorAlvo.get(chave) ?? Promise.resolve();
  const atual = anterior.then(operacao, operacao);
  const fim = atual.then(
    () => undefined,
    () => undefined,
  );
  filaPorAlvo.set(chave, fim);
  void fim.then(() => {
    if (filaPorAlvo.get(chave) === fim) filaPorAlvo.delete(chave);
  });
  return atual;
}

/** Iguais para gravar? Escalares por `===`, listas item a item. */
function mesmoValor(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

function comoMapa(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

interface RecusaDeCampo {
  campo: string;
  motivo: string;
  mensagem: string;
}

type Desfecho =
  | { gravado: true; campos: Record<string, unknown>; sem_mudanca?: true }
  | { gravado: false; motivo: string; mensagem: string };

/**
 * Grava os campos do CONTATO na ficha do contato da conversa, depois da MESMA
 * conferência do negócio (`conferirCamposPersonalizados`: padrão do campo e o
 * Jev, "o cliente disse isto?"). O que ela recusa volta como ensino e não é
 * gravado.
 */
async function gravarNoContato(
  ctx: McpContext,
  contato: string,
  pedidos: Record<string, unknown>,
): Promise<Desfecho & { recusados?: RecusaDeCampo[] }> {
  const conferencia = await conferirCamposPersonalizados(ctx, { contatoId: contato }, pedidos);
  const recusados: RecusaDeCampo[] = conferencia.recusados.map((r) => ({
    campo: r.campo,
    motivo: String(r.motivo),
    mensagem: r.mensagem,
  }));
  const validos = conferencia.custom_fields ?? pedidos;
  if (Object.keys(validos).length === 0) {
    return { gravado: false, motivo: "nada_gravado", mensagem: "nenhum campo do contato foi gravado.", recusados };
  }
  const desfecho = await gravarNoContatoConferido(ctx, contato, validos);
  return { ...desfecho, recusados };
}

async function gravarNoContatoConferido(
  ctx: McpContext,
  contato: string,
  validos: Record<string, unknown>,
): Promise<Desfecho> {
  return emSequencia(JSON.stringify([ctx.organizationId, "contato", contato]), async () => {
    const { data: linha, error } = await ctx.supabase
      .from("contacts")
      .select("id, custom_fields, is_personal, is_anonymized")
      .eq("organization_id", ctx.organizationId)
      .eq("id", contato)
      .maybeSingle();
    if (error) return { gravado: false, motivo: "indisponivel", mensagem: "não consegui ler a ficha agora." };
    const ficha = linha as { custom_fields: unknown; is_personal: boolean | null; is_anonymized: boolean | null } | null;
    if (!ficha) {
      return { gravado: false, motivo: "contato_nao_encontrado", mensagem: "não encontrei a ficha desta conversa." };
    }
    if (ficha.is_personal === true) {
      return {
        gravado: false,
        motivo: "contato_pessoal",
        mensagem: "este contato foi marcado como pessoal — nada se escreve para ele; siga a conversa.",
      };
    }
    if (ficha.is_anonymized === true) {
      return {
        gravado: false,
        motivo: "contato_anonimizado",
        mensagem: "esse contato exerceu o direito de exclusão de dados; não é possível registrar informações dele.",
      };
    }
    const atual = comoMapa(ficha.custom_fields);
    const mudam = Object.fromEntries(Object.entries(validos).filter(([k, v]) => !mesmoValor(atual[k], v)));
    if (Object.keys(mudam).length === 0) return { gravado: true, campos: validos, sem_mudanca: true };
    try {
      // Só as chaves que MUDAM, mescladas DENTRO do banco
      // (`fn_contato_anotar_campos`): regravar o mapa lido apagaria a edição
      // humana feita entre a leitura e a escrita.
      await patchContactHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        contato,
        { custom_fields: mudam },
        { mesclarCamposPersonalizados: true },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        // O padrão do campo (`padrao`) recusou: a frase é a que o dono escreveu.
        return {
          gravado: false,
          motivo: "fora_do_padrao",
          mensagem: `${err.message} Não grave assim: pergunte de novo à pessoa.`,
        };
      }
      if (err instanceof ApiError && err.status === 403) {
        return { gravado: false, motivo: "contato_anonimizado", mensagem: err.message };
      }
      throw err;
    }
    return { gravado: true, campos: validos };
  });
}

/**
 * Grava os campos do NEGÓCIO no negócio aberto do contato da conversa.
 * Devolve também as recusas que a conferência do negócio fez campo a campo.
 */
async function gravarNoNegocio(
  ctx: McpContext,
  contato: string,
  validos: Record<string, unknown>,
): Promise<Desfecho & { recusados?: RecusaDeCampo[] }> {
  const { data, error } = await ctx.supabase
    .from("crm_leads")
    .select("id, pipeline_id, status, custom_fields")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contato)
    .eq("status", "open");
  if (error) return { gravado: false, motivo: "indisponivel", mensagem: "não consegui ler o negócio agora; tente de novo." };
  const abertos = (data ?? []) as Array<{ id: string; pipeline_id: string | null; custom_fields: unknown }>;
  if (abertos.length === 0) {
    return {
      gravado: false,
      motivo: "sem_negocio_aberto",
      mensagem: "este cliente não tem negócio aberto, e o campo é do NEGÓCIO: não dá para gravá-lo agora; siga a conversa.",
    };
  }
  if (abertos.length > 1) {
    return {
      gravado: false,
      motivo: "negocio_ambiguo",
      mensagem:
        `este cliente tem ${abertos.length} negócios abertos e o campo é do NEGÓCIO: não grave por palpite; ` +
        "siga a conversa e deixe a equipe escolher o negócio.",
    };
  }
  const negocio = abertos[0]!;
  const escopo = podeOperarNoFunil(ctx.funisDoTurno, negocio.pipeline_id);
  if (!escopo.permitido) {
    return { gravado: false, motivo: escopo.motivo, mensagem: recusaParaOModelo(escopo) ?? "ação não permitida." };
  }

  return emSequencia(JSON.stringify([ctx.organizationId, "negocio", negocio.id]), async () => {
    // Releitura dentro da fila: a chamada anterior pode ter acabado de gravar.
    const { data: agora } = await ctx.supabase
      .from("crm_leads")
      .select("custom_fields")
      .eq("organization_id", ctx.organizationId)
      .eq("id", negocio.id)
      .maybeSingle();
    const atual = comoMapa((agora as { custom_fields?: unknown } | null)?.custom_fields ?? negocio.custom_fields);
    const mudam = Object.fromEntries(Object.entries(validos).filter(([k, v]) => !mesmoValor(atual[k], v)));
    if (Object.keys(mudam).length === 0) return { gravado: true, campos: validos, sem_mudanca: true };
    let resultado: Record<string, unknown>;
    try {
      // O MESMO caminho de `crm_update_lead`: conferência do que o cliente disse
      // (#2234), opção e padrão do funil, merge no banco, atividade e auditoria.
      resultado = (await crmUpdateLead.handler({ lead_id: negocio.id, custom_fields: mudam }, ctx)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        return {
          gravado: false,
          motivo: "fora_do_padrao",
          mensagem: `${err.message} Não grave assim: pergunte de novo à pessoa.`,
        };
      }
      throw err;
    }
    const recusados = Array.isArray(resultado.campos_nao_gravados)
      ? (resultado.campos_nao_gravados as Array<{ campo?: unknown; motivo?: unknown; mensagem?: unknown }>).map((r) => ({
          campo: String(r.campo ?? ""),
          motivo: String(r.motivo ?? "nao_conferido"),
          mensagem: String(r.mensagem ?? ""),
        }))
      : [];
    const fora = new Set(recusados.map((r) => r.campo));
    const gravados = Object.fromEntries(Object.entries(validos).filter(([k]) => !fora.has(k)));
    if (Object.keys(gravados).length === 0) {
      return { gravado: false, motivo: "nada_gravado", mensagem: "nenhum campo do negócio foi gravado.", recusados };
    }
    return { gravado: true, campos: gravados, recusados };
  });
}

export const crmSetCustomField: McpToolDefinition<typeof setCampoShape> = {
  name: "crm_set_custom_field",
  description:
    "Grava campos personalizados com o que a pessoa respondeu (ex.: a opção que ela escolheu numa pergunta " +
    "com botões). Cada campo é gravado onde a empresa o criou: campo do CONTATO na ficha do cliente desta " +
    "conversa, campo do NEGÓCIO no negócio aberto dele. Só grave o que a pessoa disse ou escolheu, nunca um " +
    "palpite. Em campo de opção, use o nome de uma das opções listadas; o valor é conferido pelo tipo do campo " +
    "e o que não servir volta recusado, com o motivo. O retorno `gravado: true` é o que permite dizer que " +
    "ficou anotado.",
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
        mensagem: "esta ferramenta só grava campos do cliente de uma conversa em atendimento.",
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

    const porEntidade: Record<EntidadeDoCampo, Record<string, unknown>> = { contato: {}, negocio: {} };
    const recusados: RecusaDeCampo[] = [];
    for (const [chaveDoModelo, bruto] of entradas) {
      const alvo = chaveDoModelo.trim().toLowerCase();
      const campo = definicoes.find((d) => d.key.toLowerCase() === alvo);
      // Campo NÃO público responde como inexistente, sem o rótulo: o agente não
      // lê esses campos, e confirmar que a chave existe (e como se chama) já é
      // revelar o que só o administrador vê.
      if (!campo || !campo.publico) {
        recusados.push({
          campo: chaveDoModelo,
          motivo: "campo_inexistente",
          mensagem: `«${chaveDoModelo}» não é um campo desta empresa. Campos disponíveis: ${chavesDisponiveis(definicoes)}.`,
        });
        continue;
      }
      const convertido = converterValorDoCampo(campo, bruto);
      if (!convertido.ok) {
        recusados.push({ campo: campo.key, motivo: convertido.motivo, mensagem: convertido.mensagem });
        continue;
      }
      porEntidade[campo.entidade][campo.key] = convertido.valor;
    }

    const gravados: Record<string, unknown> = {};
    let algumGravado = false;
    let semMudanca = true;
    for (const entidade of ["contato", "negocio"] as const) {
      const validos = porEntidade[entidade];
      if (Object.keys(validos).length === 0) continue;
      const desfecho: Desfecho & { recusados?: RecusaDeCampo[] } =
        entidade === "contato"
          ? await gravarNoContato(ctx, contato, validos)
          : await gravarNoNegocio(ctx, contato, validos);
      if (desfecho.recusados) recusados.push(...desfecho.recusados);
      if (desfecho.gravado) {
        algumGravado = true;
        if (!desfecho.sem_mudanca) semMudanca = false;
        Object.assign(gravados, desfecho.campos);
      } else {
        for (const chave of Object.keys(validos)) {
          if (!recusados.some((r) => r.campo === chave)) {
            recusados.push({ campo: chave, motivo: desfecho.motivo, mensagem: desfecho.mensagem });
          }
        }
      }
    }

    const comRecusas = (r: Record<string, unknown>) =>
      recusados.length > 0
        ? { ...r, campos_nao_gravados: recusados, erro_de_ensino: [...new Set(recusados.map((x) => x.mensagem))].join(" ") }
        : r;

    if (!algumGravado) return comRecusas({ gravado: false, motivo: "nada_gravado" });
    return comRecusas({ gravado: true, campos: gravados, ...(semMudanca ? { sem_mudanca: true } : {}) });
  },
};
