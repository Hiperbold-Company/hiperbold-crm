/**
 * Os EFEITOS dos blocos de conversa (lote 2): enviar a mensagem/pergunta (ou a
 * nova tentativa, ou o aviso de tempo esgotado) e registrar a resposta aceita.
 *
 * ─── Envio ─────────────────────────────────────────────────────────────────
 *
 * Sai pelo `sendMessageHandler` (o mesmo de toda a casa), direto, nunca pelo
 * turno do worker (`followup-turn.ts`), que só conhece texto e um adaptador
 * fixo. Antes de enviar, nesta ordem — o primeiro que falha vira o motivo do
 * ramo "Erro", legível no histórico (`ERROS_DO_EFEITO`):
 *   1. a conversa do contato: na execução que começou por um comentário, a do
 *      Direct de quem comentou, na conexão do comentário (`conversa-do-direct.ts`;
 *      sem ela: `sem_conversa_direct` — a pessoa ainda não respondeu); na que
 *      começou por "Mensagem recebida" no Messenger ou no Direct, a conversa do
 *      gatilho (sem ela: `sem_conversa_social`); nas demais, a de WhatsApp do
 *      contato (sem ela: `sem_conversa_whatsapp`). Bloco com "Conexão" escolhida:
 *      a conversa do contato NAQUELA conexão, e a execução que já tem conversa
 *      ativa (um bloco anterior escolheu) usa a dela — sem ela:
 *      `sem_conversa_na_conexao`, nunca outra conexão;
 *   2. o texto que sai (com as opções numeradas, se o canal não as desenha)
 *      dentro do teto do canal (`tetoDoTextoEmBytes`; Direct: 1000 bytes):
 *      `texto_longo_instagram` (`texto_longo_rede_social` fora do Instagram);
 *   3. o contato bloqueado (opt-out): `contato_bloqueado`;
 *   4. a janela de 24h fechada no canal oficial: `janela_fechada`;
 *   5. o teto de 30 mensagens automáticas por hora: `teto_por_hora`.
 * A linha nasce marcada `metadata.origem_automacao` (é o que o teto conta) e
 * com id determinístico por execução+passo: o replay do mesmo passo não cria
 * uma segunda linha. O envio bem-sucedido por uma conexão escolhida devolve
 * `vars.conversa_ativa` (`varsDaConversaAtiva`): os blocos seguintes em branco
 * e a espera da resposta passam a usar essa conversa.
 *
 * ─── Resposta ──────────────────────────────────────────────────────────────
 *
 * Grava no campo pela MESMA operação de campo auditada do bloco `field_op`
 * (`executarOperacoes`, handlers de negócio/contato), com o valor literal, e
 * devolve `vars.resposta` (ver `lib/automacoes/conversa.ts`). O detalhe do
 * evento leva só o id da opção e o nome do campo — nunca o texto do contato.
 */
import { createHash } from "node:crypto";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { opcoesNativas, tetoDoTextoEmBytes } from "@/lib/channels/capabilities";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { estadoDaJanela } from "@/lib/channels/janela";
import { bytesDoTextoQueSai } from "@/lib/channels/opcoes-numeradas";
import type { OutboundInteractive } from "@/lib/channels/types";
import type { ResultadoDoEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import type { AcaoDeConversa } from "@/lib/followup/node-handlers";

import { varsDaResposta } from "../conversa";
import { conversaDoEnvio, conversaNaConexao, type ConversaDoContato } from "../conversa-de-whatsapp";
import {
  canalSocialDaExecucao,
  conversaAtivaDasVars,
  escopoDoDirect,
  varsDaConversaAtiva,
} from "../conversa-do-direct";
import type { FieldOp } from "../schemas";
import { renderizar } from "../template-vars";
import {
  metadataDeOrigemAutomacao,
  MOTIVO_TETO_EXCEDIDO,
  podeEnviarMensagemAutomatica,
} from "../teto-de-mensagens";
import type { Contexto, Passo } from "./index";

/** A régua do teto do canal, a mesma da publicação (`validate-publish.ts`). */
export { bytesDoTextoQueSai };

type NoDeConversa = Extract<FlowNode, { type: "message" | "question" | "wait" }>;

/** Limites do WhatsApp para o corpo: com botões/lista nativos, e texto simples. */
export const LIMITE_DO_CORPO_COM_OPCOES = 1024;
export const LIMITE_DO_CORPO = 4096;

/** Uuid estável a partir da execução e do passo: o replay acha a MESMA linha de `messages`. */
export function idDaMensagemDoPasso(enrollmentId: string, chave: string, envio: string): string {
  const h = createHash("sha256")
    .update(`automacao:${enrollmentId}:${chave}:${envio}`)
    .digest("hex");
  // Formato v4 (versão e variante fixas) para passar em qualquer validação de uuid.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** O texto que sai neste envio, ainda sem renderizar. `null` = este bloco não tem o que enviar. */
export function textoDoEnvio(
  node: NoDeConversa,
  envio: Extract<AcaoDeConversa, { tipo: "enviar" }>["envio"],
): string | null {
  if (node.type === "message") {
    if (envio === "nova_tentativa") return node.config.invalid_reply?.message ?? node.config.body;
    return envio === "mensagem" ? node.config.body : null;
  }
  if (node.type === "question") {
    if (envio === "mensagem") return node.config.question;
    if (envio === "nova_tentativa") return node.config.retry_message ?? node.config.question;
    return node.config.timeout_message ?? null;
  }
  return null;
}

/** As opções que acompanham o envio: só o bloco de mensagem, e só na mensagem e na nova tentativa. */
function opcoesDoEnvio(node: NoDeConversa): OutboundInteractive | undefined {
  if (node.type !== "message" || !node.config.options) return undefined;
  return node.config.options as OutboundInteractive;
}

async function contatoBloqueado(c: Contexto): Promise<boolean> {
  const { data, error } = await c.admin
    .from("contacts")
    .select("is_blocked")
    .eq("organization_id", c.org)
    .eq("id", c.contatoId)
    .maybeSingle();
  if (error) throw new Error("contato_indeterminado");
  return Boolean((data as { is_blocked?: boolean } | null)?.is_blocked);
}

/** A "Conexão" escolhida no bloco (Mensagem, Pergunta); ausente = a dos blocos anteriores. */
function conexaoDoBloco(node: NoDeConversa): string | undefined {
  if (node.type !== "message" && node.type !== "question") return undefined;
  return node.config.channel_session_id;
}

/** As variáveis da execução: as da inscrição, ou as dos fatos (o mesmo `vars`). */
function varsDaExecucao(c: Contexto): Record<string, unknown> | undefined {
  return c.vars ?? c.fatos?.vars;
}

async function enviar(
  c: Contexto,
  node: NoDeConversa,
  envio: Extract<AcaoDeConversa, { tipo: "enviar" }>["envio"],
  chave: string,
): Promise<Passo & { vars?: Record<string, unknown> }> {
  const vars = varsDaExecucao(c);
  const conexao = conexaoDoBloco(node);
  // Conexão escolhida aqui ou num bloco anterior: só ela serve.
  const naConexao = conexao !== undefined || conversaAtivaDasVars(vars) !== null;
  const escopo = escopoDoDirect(vars);
  // `canal` só na rede social (Direct, Messenger): o histórico diz por onde
  // saiu; o WhatsApp segue como era. Com a conexão do bloco, o canal só é
  // conhecido depois de achar a conversa.
  let canal = conexao ? null : canalSocialDaExecucao(vars);
  let base: Record<string, unknown> = { tipo: node.type, envio, ...(canal ? { canal } : {}) };
  const bruto = textoDoEnvio(node, envio);
  if (bruto === null) return { ok: false, erro: "efeito_falhou", detalhe: base };
  const corpo = renderizar(bruto, c.fatos, c.agora).trim();
  if (!corpo) return { ok: false, erro: "envio_falhou", detalhe: base };
  // O limite vale para o texto que SAI: as variáveis podem crescer o corpo
  // depois da validação do editor (1024 com opções nativas, 4096 sem).
  const comOpcoes = envio !== "tempo_esgotado" && opcoesDoEnvio(node) !== undefined;
  if (corpo.length > (comOpcoes ? LIMITE_DO_CORPO_COM_OPCOES : LIMITE_DO_CORPO)) {
    return { ok: false, erro: comOpcoes ? "texto_longo_com_opcoes" : "texto_longo", detalhe: base };
  }

  // Os mesmos ids (contato + gêmeos de telefone) para a conversa e para o teto.
  const ids = await idsDoContatoEGemeos(c.admin, c.org, c.contatoId);
  // A mesma escolha da condição "Janela de 24h aberta" (`conversaDoEnvio`).
  let conversa: ConversaDoContato | null;
  if (conexao) {
    const naConexaoDoBloco = await conversaNaConexao(c.admin, c.org, conexao, ids);
    canal = naConexaoDoBloco?.canal ?? null;
    conversa = naConexaoDoBloco;
  } else {
    conversa = await conversaDoEnvio(c.admin, c.org, vars, ids);
  }
  if (!conversa) {
    return {
      ok: false,
      erro: naConexao
        ? "sem_conversa_na_conexao"
        : escopo
          ? "sem_conversa_direct"
          : canal
            ? "sem_conversa_social"
            : "sem_conversa_whatsapp",
      detalhe: base,
    };
  }
  if (conexao && canal) base = { ...base, canal };
  // Teto do canal (o Direct do Instagram é menor que o do WhatsApp), medido no
  // texto que SAI: com as opções numeradas quando o canal não as desenha.
  const tetoDoCanal = tetoDoTextoEmBytes(conversa.provider);
  if (tetoDoCanal !== null) {
    const opcoes = envio === "tempo_esgotado" ? undefined : opcoesDoEnvio(node);
    if (bytesDoTextoQueSai(corpo, opcoes, opcoesNativas(conversa.provider)) > tetoDoCanal) {
      const foraDoInstagram = canal !== null && canal !== "direct";
      return { ok: false, erro: foraDoInstagram ? "texto_longo_rede_social" : "texto_longo_instagram", detalhe: base };
    }
  }
  if (await contatoBloqueado(c)) return { ok: false, erro: "contato_bloqueado", detalhe: base };
  if (estadoDaJanela(conversa.provider, conversa.last_inbound_at, c.agora).tipo === "fechada") {
    return { ok: false, erro: "janela_fechada", detalhe: base };
  }
  const teto = await podeEnviarMensagemAutomatica(c.admin, {
    organizationId: c.org,
    contactIds: ids,
    agora: c.agora,
  });
  if (!teto.pode) {
    return {
      ok: false,
      erro: teto.motivo === MOTIVO_TETO_EXCEDIDO ? "teto_por_hora" : "teto_indisponivel",
      detalhe: base,
    };
  }

  const interactive = envio === "tempo_esgotado" ? undefined : opcoesDoEnvio(node);
  try {
    const msg = await sendMessageHandler(
      c.admin,
      {
        organization_id: c.org,
        actor: { type: "webhook_source", id: c.pointerId },
        requestId: `${c.handler.requestId}:${envio}`,
        internalMessageId: idDaMensagemDoPasso(c.enrollmentId, chave, envio),
      },
      {
        conversation_id: conversa.id,
        type: "text",
        body: corpo,
        metadata: metadataDeOrigemAutomacao({
          enrollmentId: c.enrollmentId,
          pointerId: c.pointerId,
        }),
        ...(interactive ? { interactive } : {}),
      } as Parameters<typeof sendMessageHandler>[2],
    );
    if ((msg as { status?: string }).status === "failed")
      return { ok: false, erro: "envio_falhou", detalhe: base };
    return {
      ok: true,
      detalhe: { ...base, message_id: (msg as { id?: string }).id ?? null },
      // A conexão escolhida aqui vira a dos blocos seguintes (e da espera).
      ...(conexao
        ? {
            vars: varsDaConversaAtiva({ conversationId: conversa.id, channelSessionId: conexao, canal }),
          }
        : {}),
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "janela_fechada")
        return { ok: false, erro: "janela_fechada", detalhe: base };
      // Organização parada (`OrgNaoOperanteError`, 403 `org_suspended`): não é o
      // contato que pediu para parar, é a conta que não envia agora.
      if (err.code === "org_suspended") return { ok: false, erro: "organizacao_bloqueada", detalhe: base };
      if (err.status === 403) return { ok: false, erro: "contato_bloqueado", detalhe: base };
    }
    return { ok: false, erro: "envio_falhou", detalhe: base };
  }
}

async function registrar(
  c: Contexto,
  node: NoDeConversa,
  acao: Extract<AcaoDeConversa, { tipo: "registrar_resposta" }>,
  gravarCampo: (ops: FieldOp[]) => Promise<Passo>,
): Promise<Passo & { vars?: Record<string, unknown> }> {
  // O rótulo vem da CONFIGURAÇÃO do bloco (escrito por quem montou a automação),
  // nunca do texto do contato: é o que a tela de execuções mostra no lugar do id.
  const rotulo =
    acao.opcao_id && node.type === "message"
      ? node.config.options?.items.find((i) => i.id === acao.opcao_id)?.label
      : undefined;
  const canal = canalSocialDaExecucao(varsDaExecucao(c));
  const base = {
    tipo: node.type,
    envio: "resposta",
    ...(canal ? { canal } : {}),
    ...(acao.opcao_id ? { opcao_id: acao.opcao_id } : {}),
    ...(rotulo ? { opcao_rotulo: rotulo } : {}),
  };
  const destino =
    node.type === "message" || node.type === "question" ? node.config.save_to : undefined;
  if (destino) {
    const r = await gravarCampo([{ target: destino, op: "set", value: acao.valor }]);
    if (!r.ok) return { ok: false, erro: r.erro ?? "efeito_falhou", detalhe: base };
  }
  return {
    ok: true,
    // CPF e a espera "até responder" não guardam o valor (ver `varsDaResposta`).
    vars: varsDaResposta(node, acao, c.fatos?.vars),
    detalhe: { ...base, ...(destino && "key" in destino ? { campo: destino.key } : {}) },
  };
}

export async function executarConversa(
  c: Contexto,
  node: NoDeConversa,
  acao: AcaoDeConversa,
  chave: string,
  gravarCampo: (ops: FieldOp[]) => Promise<Passo>,
): Promise<ResultadoDoEfeito> {
  let passo: Passo & { vars?: Record<string, unknown> };
  try {
    passo =
      acao.tipo === "enviar"
        ? await enviar(c, node, acao.envio, chave)
        : await registrar(c, node, acao, gravarCampo);
  } catch {
    passo = {
      ok: false,
      erro: acao.tipo === "enviar" ? "envio_falhou" : "efeito_falhou",
      detalhe: { tipo: node.type },
    };
  }
  return {
    desfecho: passo.ok ? { ok: true } : { ok: false, erro: passo.erro ?? "efeito_falhou" },
    ...(passo.vars ? { vars: passo.vars } : {}),
    detalhes: [{ ...passo.detalhe, ok: passo.ok, ...(passo.erro ? { erro: passo.erro } : {}) }],
  };
}
