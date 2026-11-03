import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verificationChallenge } from "@/lib/channels/meta/webhook";
import { CAMPOS_DO_WEBHOOK_INSTAGRAM, CAMPOS_DO_WEBHOOK_MESSENGER } from "@/lib/channels/meta-social/constantes";
import {
  assinaturaMetaSocialConfere,
  envelopeMetaSocial,
  lerEventosMetaSocial,
} from "@/lib/channels/meta-social/webhook";

const assina = (corpo: string, segredo: string) =>
  `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;

const ler = (payload: unknown) => lerEventosMetaSocial(envelopeMetaSocial.parse(payload));

describe("assinatura do webhook social", () => {
  const corpo = JSON.stringify({ object: "instagram", entry: [] });
  const segredos = ["segredo-do-app-da-meta", "segredo-do-app-do-instagram"];

  it("aceita assinatura feita com QUALQUER um dos segredos da instalação", () => {
    expect(assinaturaMetaSocialConfere(corpo, assina(corpo, segredos[0]!), segredos)).toBe(true);
    expect(assinaturaMetaSocialConfere(corpo, assina(corpo, segredos[1]!), segredos)).toBe(true);
  });

  it("recusa segredo alheio, corpo alterado e cabeçalho ausente", () => {
    expect(assinaturaMetaSocialConfere(corpo, assina(corpo, "outro"), segredos)).toBe(false);
    expect(assinaturaMetaSocialConfere(`${corpo} `, assina(corpo, segredos[0]!), segredos)).toBe(false);
    expect(assinaturaMetaSocialConfere(corpo, null, segredos)).toBe(false);
    expect(assinaturaMetaSocialConfere(corpo, assina(corpo, segredos[0]!), [])).toBe(false);
  });
});

describe("handshake", () => {
  it("devolve o challenge só com o verify token certo", () => {
    const p = (t: string) =>
      new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": t, "hub.challenge": "42" });
    expect(verificationChallenge(p("token-da-instalacao"), "token-da-instalacao")).toBe("42");
    expect(verificationChallenge(p("errado"), "token-da-instalacao")).toBeNull();
    expect(verificationChallenge(p(""), "")).toBeNull();
  });
});

describe("leitura do payload", () => {
  const IG = "17841400000000001";
  const CLIENTE = "990001";

  it("texto do cliente no Instagram", () => {
    const [e] = ler({
      object: "instagram",
      entry: [
        {
          id: IG,
          time: 1,
          messaging: [
            {
              sender: { id: CLIENTE },
              recipient: { id: IG },
              timestamp: 1_762_000_000_000,
              message: { mid: "mid.1", text: "oi" },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({
      tipo: "mensagem",
      plataforma: "instagram",
      contaId: IG,
      clienteId: CLIENTE,
      mid: "mid.1",
      direcao: "inbound",
      texto: "oi",
      anexos: [],
    });
    expect(e && e.tipo === "mensagem" && e.enviadaEm).toBe(new Date(1_762_000_000_000).toISOString());
  });

  it("imagem do cliente no Messenger (object page)", () => {
    const [e] = ler({
      object: "page",
      entry: [
        {
          id: "PAGINA",
          messaging: [
            {
              sender: { id: "PSID" },
              recipient: { id: "PAGINA" },
              message: {
                mid: "m.2",
                attachments: [{ type: "image", payload: { url: "https://lookaside.fbsbx.com/x.jpg" } }],
              },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({
      plataforma: "messenger",
      clienteId: "PSID",
      anexos: [{ type: "image", url: "https://lookaside.fbsbx.com/x.jpg" }],
    });
  });

  it("eco: a conta é o remetente e o cliente é o destinatário", () => {
    const [e] = ler({
      object: "instagram",
      entry: [
        {
          id: IG,
          messaging: [
            {
              sender: { id: IG },
              recipient: { id: CLIENTE },
              message: { mid: "mid.3", text: "respondi pelo app", is_echo: true, app_id: 123 },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ direcao: "outbound", clienteId: CLIENTE, appId: "123" });
  });

  it("reação e postback são ignorados; leitura e apagada viram eventos próprios", () => {
    const eventos = ler({
      object: "instagram",
      entry: [
        {
          id: IG,
          messaging: [
            { sender: { id: CLIENTE }, recipient: { id: IG }, read: { mid: "mid.1" } },
            { sender: { id: CLIENTE }, recipient: { id: IG }, reaction: { mid: "mid.1", action: "react" } },
            { sender: { id: CLIENTE }, recipient: { id: IG }, postback: { title: "x" } },
            { sender: { id: CLIENTE }, recipient: { id: IG }, message: { mid: "mid.9", is_deleted: true } },
          ],
        },
      ],
    });
    expect(eventos).toEqual([
      { tipo: "lida", plataforma: "instagram", contaId: IG, clienteId: CLIENTE, mid: "mid.1", ateMs: null, lidaEm: null },
      { tipo: "apagada", plataforma: "instagram", contaId: IG, mid: "mid.9" },
    ]);
  });

  it("message_reads do Messenger vira leitura até a marca d'água; entrada sem id é pulada", () => {
    const eventos = ler({
      object: "page",
      entry: [
        { messaging: [{ sender: { id: CLIENTE }, recipient: { id: "PAG" }, message: { mid: "m", text: "a" } }] },
        {
          id: "PAG",
          messaging: [{ sender: { id: CLIENTE }, recipient: { id: "PAG" }, timestamp: 1_762_000_000_500, read: { watermark: 1_762_000_000_000 } }],
        },
      ],
    });
    expect(eventos).toEqual([
      {
        tipo: "lida",
        plataforma: "messenger",
        contaId: "PAG",
        clienteId: CLIENTE,
        mid: null,
        ateMs: 1_762_000_000_000,
        lidaEm: new Date(1_762_000_000_500).toISOString(),
      },
    ]);
  });

  it("campos assinados: só o que o parser lê (sem reações no Instagram)", () => {
    expect(CAMPOS_DO_WEBHOOK_INSTAGRAM).toBe("messages,messaging_postbacks,messaging_seen,comments");
    expect(CAMPOS_DO_WEBHOOK_MESSENGER).toBe("messages,messaging_postbacks,message_echoes,message_reads");
  });

  it("item que não fecha com o entry.id e object desconhecido não viram linha", () => {
    expect(
      ler({
        object: "instagram",
        entry: [
          {
            id: IG,
            messaging: [{ sender: { id: CLIENTE }, recipient: { id: "OUTRA" }, message: { mid: "x", text: "a" } }],
          },
        ],
      }),
    ).toEqual([]);
    expect(ler({ object: "whatsapp_business_account", entry: [{ id: IG }] })).toEqual([]);
  });

  it("o formato `changes` do botão Testar do painel também é lido", () => {
    const [e] = ler({
      object: "instagram",
      entry: [
        {
          id: IG,
          changes: [
            {
              field: "messages",
              value: { sender: { id: CLIENTE }, recipient: { id: IG }, message: { mid: "t.1", text: "teste" } },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ mid: "t.1", texto: "teste" });
  });

  describe("login unificado: os dois formatos (messaging[] e changes[]) dão os MESMOS eventos", () => {
    const itens = {
      entrada: { sender: { id: CLIENTE }, recipient: { id: IG }, timestamp: 1_762_000_000_000, message: { mid: "u.1", text: "oi" } },
      eco: {
        sender: { id: IG },
        recipient: { id: CLIENTE },
        timestamp: 1_762_000_001_000,
        message: { mid: "u.2", text: "resposta", is_echo: true, app_id: 12345678 },
      },
      lida: { sender: { id: CLIENTE }, recipient: { id: IG }, timestamp: 1_762_000_002_000, read: { mid: "u.2" } },
    };
    const comoMessaging = {
      object: "instagram",
      entry: [{ id: IG, time: 1, messaging: [itens.entrada, itens.eco, itens.lida] }],
    };
    const comoChanges = {
      object: "instagram",
      entry: [
        {
          id: IG,
          time: 1,
          changes: [
            { field: "messages", value: itens.entrada },
            { field: "messages", value: itens.eco },
            { field: "messaging_seen", value: itens.lida },
          ],
        },
      ],
    };

    it("entrada, eco e leitura", () => {
      const a = ler(comoMessaging);
      expect(a).toEqual([
        expect.objectContaining({ tipo: "mensagem", direcao: "inbound", clienteId: CLIENTE, mid: "u.1", texto: "oi" }),
        expect.objectContaining({ tipo: "mensagem", direcao: "outbound", clienteId: CLIENTE, mid: "u.2", appId: "12345678" }),
        expect.objectContaining({ tipo: "lida", clienteId: CLIENTE, mid: "u.2" }),
      ]);
      expect(ler(comoChanges)).toEqual(a);
    });

    it("campo de changes que não é mensagem (comentário) é ignorado", () => {
      expect(
        ler({
          object: "instagram",
          entry: [{ id: IG, changes: [{ field: "comments", value: { id: "c1", text: "lindo", from: { id: CLIENTE } } }] }],
        }),
      ).toEqual([]);
    });
  });
});
