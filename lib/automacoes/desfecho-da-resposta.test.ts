/**
 * O desfecho das respostas do Instagram (`instagram.resposta_enviada` /
 * `instagram.resposta_falhou`) vira uma linha legível no histórico da execução
 * que pediu — e só dela.
 */
import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";

import {
  AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY,
  aplicarDesfechoDaResposta,
  lerPedidoDaAutomacao,
  type DesfechoDb,
} from "./desfecho-da-resposta.handler";
import { EVENTO_RESPOSTA_ENVIADA, EVENTO_RESPOSTA_FALHOU } from "./canal-de-comentarios";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const POINTER = "33333333-3333-4333-8333-333333333333";
const EXEC = "44444444-4444-4444-8444-444444444444";

interface Execucao {
  org: string;
  pointer: string;
  id: string;
  no: string;
}

function bancoFalso(execucoes: Execucao[]) {
  const eventos: Array<Parameters<DesfechoDb["inserirEvento"]>[0]> = [];
  const db: DesfechoDb = {
    async noAtualDaExecucao(org, pointer, id) {
      return execucoes.find((e) => e.org === org && e.pointer === pointer && e.id === id)?.no ?? null;
    },
    async inserirEvento(ev) {
      if (eventos.some((e) => e.enrollment_id === ev.enrollment_id && e.idempotency_key === ev.idempotency_key)) return false;
      eventos.push(ev);
      return true;
    },
  };
  return { db, eventos };
}

function linha(over: Partial<EventRow> & { payload?: Record<string, unknown> } = {}): EventRow {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organization_id: ORG,
    event_type: EVENTO_RESPOSTA_ENVIADA,
    entity_kind: "instagram_comment_reply",
    entity_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
    payload: {
      organization_id: ORG,
      channel_session_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      comment_id: "17890000000000000",
      tipo: "resposta_privada",
      pedido_por: `automacao:${POINTER}:${EXEC}:privada:2`,
      ...(over.payload ?? {}),
    },
  };
}

const EXECUCAO: Execucao = { org: ORG, pointer: POINTER, id: EXEC, no: "espera" };

describe("lerPedidoDaAutomacao", () => {
  it("lê pointer, execução e o nó do bloco (o passo é o último pedaço)", () => {
    expect(lerPedidoDaAutomacao(`automacao:${POINTER}:${EXEC}:privada:2`)).toEqual({
      pointerId: POINTER,
      enrollmentId: EXEC,
      noId: "privada",
    });
  });
  it("outra origem, nulo ou ids que não são uuid: null", () => {
    expect(lerPedidoDaAutomacao(null)).toBeNull();
    expect(lerPedidoDaAutomacao("inbox:usuario")).toBeNull();
    expect(lerPedidoDaAutomacao(`rule:${POINTER}:${EXEC}:x:1`)).toBeNull();
    expect(lerPedidoDaAutomacao("automacao:abc:def:x:1")).toBeNull();
  });
});

describe("aplicarDesfechoDaResposta", () => {
  it("enviada: grava 'instagram_resposta_saiu' no nó ATUAL da execução, com o nó do bloco no payload", async () => {
    const { db, eventos } = bancoFalso([EXECUCAO]);
    expect(await aplicarDesfechoDaResposta(db, linha())).toBe("gravado");
    expect(eventos).toEqual([
      {
        organization_id: ORG,
        enrollment_id: EXEC,
        node_id: "espera",
        event_type: "instagram_resposta_saiu",
        payload: { tipo: "resposta_privada", no_id: "privada" },
        idempotency_key: "ig_desfecho:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]);
    // A chave não tem a forma de passo do motor (`:<número>` no fim).
    expect(eventos[0]!.idempotency_key).not.toMatch(/:[0-9]+$/);
  });

  it("falhou: grava o motivo (código), nunca texto", async () => {
    const { db, eventos } = bancoFalso([EXECUCAO]);
    const r = await aplicarDesfechoDaResposta(
      db,
      linha({ event_type: EVENTO_RESPOSTA_FALHOU, payload: { tipo: "resposta_publica", motivo: "prazo_de_7_dias" } }),
    );
    expect(r).toBe("gravado");
    expect(eventos[0]).toMatchObject({
      event_type: "instagram_resposta_falhou",
      payload: { tipo: "resposta_publica", no_id: "privada", motivo: "prazo_de_7_dias" },
    });
  });

  it("re-drain do mesmo evento não grava duas linhas", async () => {
    const { db, eventos } = bancoFalso([EXECUCAO]);
    await aplicarDesfechoDaResposta(db, linha());
    expect(await aplicarDesfechoDaResposta(db, linha())).toBe("ja_gravado");
    expect(eventos).toHaveLength(1);
  });

  it("pedido_por nulo ou de outra origem: ignora", async () => {
    const { db, eventos } = bancoFalso([EXECUCAO]);
    expect(await aplicarDesfechoDaResposta(db, linha({ payload: { pedido_por: null } }))).toBe("ignorado");
    expect(await aplicarDesfechoDaResposta(db, linha({ payload: { pedido_por: "inbox:fulano" } }))).toBe("ignorado");
    expect(eventos).toHaveLength(0);
  });

  it("execução de OUTRA organização (ou payload que discorda da linha): ignora", async () => {
    const { db, eventos } = bancoFalso([{ ...EXECUCAO, org: OUTRA_ORG }]);
    expect(await aplicarDesfechoDaResposta(db, linha())).toBe("ignorado");
    const { db: db2, eventos: ev2 } = bancoFalso([EXECUCAO]);
    expect(await aplicarDesfechoDaResposta(db2, linha({ payload: { organization_id: OUTRA_ORG } }))).toBe("ignorado");
    expect(eventos).toHaveLength(0);
    expect(ev2).toHaveLength(0);
  });

  it("pointer que não é o da execução: ignora", async () => {
    const { db, eventos } = bancoFalso([{ ...EXECUCAO, pointer: "55555555-5555-4555-8555-555555555555" }]);
    expect(await aplicarDesfechoDaResposta(db, linha())).toBe("ignorado");
    expect(eventos).toHaveLength(0);
  });
});

describe("o histórico lê a linha", () => {
  const nos = { privada: { type: "instagram_private_reply", label: "Responder em privado" } } as never;
  it("saiu", () => {
    const l = descreveEvento(
      { node_id: "espera", event_type: "instagram_resposta_saiu", payload: { tipo: "resposta_privada", no_id: "privada" } } as never,
      nos,
      "pt-BR",
      "automacao",
    );
    expect(l.titulo).toBe("Resposta privada saiu");
    expect(l.detalhe).toBeNull();
  });
  it.each([
    ["prazo_de_7_dias", "passou o prazo de 7 dias do comentário"],
    ["comentario_desconhecido", "o comentário não existe mais no Instagram"],
    ["inelegivel:2534025", "o Instagram não aceita resposta privada para este comentário"],
    ["conta_indisponivel", "a conexão do Instagram não está disponível"],
    ["envio_sem_confirmacao", "o Instagram não confirmou o envio, e ele não foi repetido para não chegar duas vezes"],
    ["meta_social_send_failed:100", "o Instagram recusou o envio (código 100)"],
  ])("falhou (%s)", (motivo, frase) => {
    const l = descreveEvento(
      { node_id: "espera", event_type: "instagram_resposta_falhou", payload: { tipo: "resposta_privada", motivo } } as never,
      nos,
      "pt-BR",
      "automacao",
    );
    expect(l.titulo).toBe("Resposta privada falhou");
    expect(l.detalhe).toBe(frase);
  });
});

describe("registro", () => {
  it("o handler está no registry e consome os dois eventos", () => {
    ensureHandlersRegistered();
    const h = getRegisteredHandlers().find((x) => x.key === AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY);
    expect(h?.events.sort()).toEqual([EVENTO_RESPOSTA_ENVIADA, EVENTO_RESPOSTA_FALHOU].sort());
  });
});
