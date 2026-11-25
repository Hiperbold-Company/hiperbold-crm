/**
 * BOTÕES E LISTA NA MENSAGEM DO AGENTE — as duas pontas, puras.
 *
 * SAÍDA: o argumento `opcoes` do `send_message` vira o `OutboundInteractive`
 * que o handler de envio já sabe entregar (`app/api/v1/messages/_handler.ts`):
 * nativo no canal que desenha opções, texto numerado nos outros
 * (`lib/channels/opcoes-numeradas.ts`). O modelo escreve só os TÍTULOS; os ids
 * nascem aqui (`opcao_1`…), para ele não ter o que inventar.
 *
 * ENTRADA: a resposta do cliente — o toque no botão (o webhook grava o título
 * como corpo e o id em `metadata.reply`) ou o número/rótulo digitado — é
 * casada com as opções da última mensagem que as ofereceu, pela MESMA régua das
 * automações (`casarRespostaComOpcao`). O que volta ao modelo é o TÍTULO
 * escolhido, ao lado do texto cru (que nunca é reescrito).
 */
import { z } from "zod";

import {
  casarRespostaComOpcao,
  interactiveSchema,
  MAX_BOTOES,
  MAX_DESCRICAO_DA_LISTA,
  MAX_ITENS_DA_LISTA,
  MAX_ROTULO_DA_LISTA,
  MAX_ROTULO_DO_BOTAO,
  normalizarRotulo,
} from "@/lib/channels/opcoes-numeradas";
import type { OutboundInteractive } from "@/lib/channels/types";

/** A forma ESTRITA do argumento — o schema do SDK é largo e o erro volta como ensino. */
const opcoesDoAgenteSchema = z
  .object({
    formato: z.enum(["botoes", "lista"]),
    itens: z
      .array(
        z
          .object({
            titulo: z.string().trim().min(1),
            descricao: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    texto_do_botao: z.string().trim().min(1).optional(),
  })
  .strict();

export type OpcoesConvertidas = { ok: true; interactive: OutboundInteractive } | { ok: false; mensagem: string };

const recusa = (mensagem: string): OpcoesConvertidas => ({ ok: false, mensagem });

/** O argumento `opcoes` do modelo → `OutboundInteractive`, ou a frase do erro de ensino. */
export function interactiveDasOpcoesDoAgente(bruto: unknown): OpcoesConvertidas {
  const lido = opcoesDoAgenteSchema.safeParse(bruto);
  if (!lido.success) {
    return recusa(
      'opcoes inválidas: mande { formato: "botoes" | "lista", itens: [{ titulo, descricao? }], texto_do_botao? }.',
    );
  }
  const { formato, itens, texto_do_botao } = lido.data;
  const normalizados = itens.map((i) => normalizarRotulo(i.titulo));
  if (new Set(normalizados).size !== normalizados.length) {
    return recusa("opcoes inválidas: dois itens têm o mesmo título; cada opção precisa de um título diferente.");
  }

  let interactive: OutboundInteractive;
  if (formato === "botoes") {
    if (itens.length > MAX_BOTOES) {
      return recusa(`opcoes inválidas: no máximo ${MAX_BOTOES} botões; para mais opções use formato "lista".`);
    }
    const longo = itens.find((i) => i.titulo.length > MAX_ROTULO_DO_BOTAO);
    if (longo) {
      return recusa(`opcoes inválidas: o título «${longo.titulo}» passa de ${MAX_ROTULO_DO_BOTAO} caracteres; encurte.`);
    }
    if (itens.some((i) => i.descricao !== undefined)) {
      return recusa('opcoes inválidas: botão não tem descrição; tire a descrição ou use formato "lista".');
    }
    interactive = { kind: "buttons", items: itens.map((i, n) => ({ id: `opcao_${n + 1}`, label: i.titulo })) };
  } else {
    if (itens.length > MAX_ITENS_DA_LISTA) {
      return recusa(`opcoes inválidas: a lista tem no máximo ${MAX_ITENS_DA_LISTA} itens.`);
    }
    const longo = itens.find((i) => i.titulo.length > MAX_ROTULO_DA_LISTA);
    if (longo) {
      return recusa(`opcoes inválidas: o título «${longo.titulo}» passa de ${MAX_ROTULO_DA_LISTA} caracteres; encurte.`);
    }
    if (itens.some((i) => (i.descricao?.length ?? 0) > MAX_DESCRICAO_DA_LISTA)) {
      return recusa(`opcoes inválidas: a descrição de um item passa de ${MAX_DESCRICAO_DA_LISTA} caracteres.`);
    }
    if (!texto_do_botao || texto_do_botao.length > MAX_ROTULO_DO_BOTAO) {
      return recusa(
        `opcoes inválidas: a lista precisa de texto_do_botao (o botão que abre a lista, até ${MAX_ROTULO_DO_BOTAO} caracteres).`,
      );
    }
    interactive = {
      kind: "list",
      button_label: texto_do_botao,
      items: itens.map((i, n) => ({
        id: `opcao_${n + 1}`,
        label: i.titulo,
        ...(i.descricao ? { description: i.descricao } : {}),
      })),
    };
  }
  // A régua do handler, aqui também: o que passa daqui o handler aceita.
  const conferido = interactiveSchema.safeParse(interactive);
  return conferido.success ? { ok: true, interactive: conferido.data } : recusa("opcoes inválidas.");
}

/** As opções gravadas numa linha de `messages` (`metadata.interactive`), qualquer entrega. */
export function opcoesGravadasNaMensagem(metadata: unknown): OutboundInteractive | null {
  const bruto = (metadata as { interactive?: unknown } | null | undefined)?.interactive;
  if (!bruto || typeof bruto !== "object") return null;
  const lido = interactiveSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/** O id da opção nativa tocada (`metadata.reply.id`, gravado pelo webhook oficial). */
function idDaResposta(metadata: unknown): string | null {
  const reply = (metadata as { reply?: { id?: unknown } } | null | undefined)?.reply;
  return typeof reply?.id === "string" ? reply.id : null;
}

/**
 * O TÍTULO da opção que a resposta escolhe, ou `null`. Estrito: texto livre,
 * rótulo no meio de frase e número fora da faixa não casam.
 */
export function opcaoEscolhida(
  resposta: { body: string | null; metadata: unknown },
  oferecidas: OutboundInteractive,
): string | null {
  const id = casarRespostaComOpcao({ texto: resposta.body, replyId: idDaResposta(resposta.metadata) }, oferecidas.items);
  return id === null ? null : (oferecidas.items.find((i) => i.id === id)?.label ?? null);
}
