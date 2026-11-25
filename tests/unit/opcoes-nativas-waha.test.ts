import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Opções nativas no WAHA: a ENQUETE (`sendPoll`) na ida, a reserva em texto
 * numerado e o voto (`poll.vote`) lido na volta.
 *
 * Dublê só no `fetch` (o servidor WAHA). SABOTAGEM: mandar o id em vez do
 * título como opção faz o voto não casar; cair para o texto em erro de rede faz
 * "rede não reenvia" ficar vermelho; tirar o carimbo do `external_id` do voto
 * faz o voto trocado sumir como duplicata.
 */
import { getAdapter } from "@/lib/channels";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { EVENTOS_DO_WEBHOOK_DA_SESSAO } from "@/lib/waha/client";
import {
  corpoDaEnqueteWaha,
  externalIdDoVoto,
  lerVotoDaEnquete,
  MAX_PERGUNTA_DA_ENQUETE,
  opcaoDoVoto,
} from "@/lib/waha/enquete";
import { limparMemoCheckExists } from "@/lib/waha/resolve-contact-whatsapp-id";
import type { OutboundInteractive } from "@/lib/channels/types";

const ORG = "00000000-0000-4000-8000-000000000998";
const BOTOES: OutboundInteractive = {
  kind: "buttons",
  items: [
    { id: "opcao_1", label: "Moradia" },
    { id: "opcao_2", label: "Investimento" },
  ],
};

function stubWaha(sendPoll: () => Promise<Response>) {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  const fetchMock = vi.fn().mockImplementation((u: string) => {
    const href = String(u);
    if (href.includes("/api/contacts/check-exists")) {
      return Promise.resolve(Response.json({ numberExists: true, chatId: "5531999998888@c.us" }));
    }
    if (href.includes("/api/sendPoll")) return sendPoll();
    return Promise.resolve(Response.json({ id: "true_5531999998888@c.us_3EB0TXT" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const chamadasPara = (f: ReturnType<typeof vi.fn>, trecho: string) =>
  f.mock.calls.filter(([u]) => String(u).includes(trecho)).map(([, init]) => JSON.parse(String((init as RequestInit).body)));
const envelope = (interactive: OutboundInteractive, body = "Qual o objetivo?") =>
  ({ organizationId: ORG, sessionRef: "default", to: "5531999998888@c.us", kind: "text", body, interactive }) as never;

afterEach(() => {
  limparMemoCheckExists();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WAHA — formato da enquete", () => {
  it("pergunta = texto, opções = títulos, escolha única", () => {
    expect(corpoDaEnqueteWaha("default", "5531@c.us", "Qual?", BOTOES)).toEqual({
      session: "default",
      chatId: "5531@c.us",
      poll: { name: "Qual?", options: ["Moradia", "Investimento"], multipleAnswers: false },
    });
  });

  it("não cabe numa enquete: pergunta longa, uma opção só ou títulos que colidem", () => {
    expect(corpoDaEnqueteWaha("s", "c", "x".repeat(MAX_PERGUNTA_DA_ENQUETE + 1), BOTOES)).toBeNull();
    expect(corpoDaEnqueteWaha("s", "c", "Qual?", { kind: "buttons", items: [{ id: "opcao_1", label: "Sim" }] })).toBeNull();
    expect(
      corpoDaEnqueteWaha("s", "c", "Qual?", {
        kind: "buttons",
        items: [
          { id: "opcao_1", label: "Sim" },
          { id: "opcao_2", label: "SIM" },
        ],
      }),
    ).toBeNull();
  });

  it("a matriz declara opções nativas e o webhook assina poll.vote", () => {
    expect(capabilitiesOf("waha").interactive).toBe("native");
    expect(EVENTOS_DO_WEBHOOK_DA_SESSAO).toContain("poll.vote");
  });
});

describe("WAHA — envio e reserva", () => {
  it("enquete aceita: sai por sendPoll, sem sendText", async () => {
    const f = stubWaha(() => Promise.resolve(Response.json({ id: "true_5531999998888@c.us_3EB0POLL" })));
    const r = await getAdapter("waha").send(envelope(BOTOES));
    expect(r.opcoesComoTexto).toBeUndefined();
    expect(r.externalId).toBeTruthy();
    expect(chamadasPara(f, "/api/sendPoll")[0]).toMatchObject({
      session: "default",
      poll: { name: "Qual o objetivo?", options: ["Moradia", "Investimento"], multipleAnswers: false },
    });
    expect(chamadasPara(f, "/api/sendText")).toHaveLength(0);
  });

  it("enquete recusada pelo servidor: texto numerado, e avisa", async () => {
    const f = stubWaha(() => Promise.resolve(new Response("{}", { status: 422 })));
    const r = await getAdapter("waha").send(envelope(BOTOES));
    expect(r.opcoesComoTexto).toBe(true);
    expect(chamadasPara(f, "/api/sendText")[0]!.text).toBe("Qual o objetivo?\n\n1) Moradia\n2) Investimento");
  });

  it("enquete com 500 ou 429: sobe o erro e NÃO reenvia como texto", async () => {
    for (const status of [500, 429]) {
      const f = stubWaha(() => Promise.resolve(new Response("{}", { status })));
      await expect(getAdapter("waha").send(envelope(BOTOES))).rejects.toThrow(`waha_${status}`);
      expect(chamadasPara(f, "/api/sendText")).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("pergunta maior que a enquete aceita: texto numerado sem tentar a enquete", async () => {
    const f = stubWaha(() => Promise.resolve(Response.json({ id: "x" })));
    const r = await getAdapter("waha").send(envelope(BOTOES, "y".repeat(300)));
    expect(r.opcoesComoTexto).toBe(true);
    expect(chamadasPara(f, "/api/sendPoll")).toHaveLength(0);
  });

  it("erro de REDE na enquete não reenvia como texto", async () => {
    const f = stubWaha(() => Promise.reject(new TypeError("fetch failed")));
    await expect(getAdapter("waha").send(envelope(BOTOES))).rejects.toThrow();
    expect(chamadasPara(f, "/api/sendText")).toHaveLength(0);
  });
});

describe("WAHA — o voto volta como a resposta de texto", () => {
  const evento = (vote: Record<string, unknown>) => ({
    vote: { id: "false_5531999998888@c.us_VOTO1", from: "5531999998888@c.us", fromMe: false, selectedOptions: ["Investimento"], timestamp: 1700000000, ...vote },
    poll: { id: "true_5531999998888@c.us_3EB0POLL", from: "me", fromMe: true },
  });

  it("lê o voto e casa o título com a opção oferecida (id e título)", () => {
    const v = lerVotoDaEnquete(evento({}))!;
    expect(v).toMatchObject({ pollId: "true_5531999998888@c.us_3EB0POLL", opcao: "Investimento", from: "5531999998888@c.us" });
    expect(opcaoDoVoto(v.opcao, BOTOES)).toEqual({ id: "opcao_2", label: "Investimento" });
    expect(opcaoDoVoto("investimento", BOTOES)).toEqual({ id: "opcao_2", label: "Investimento" });
    expect(opcaoDoVoto("Outra", BOTOES)).toBeNull();
  });

  it("voto retirado, voto falho e voto nosso são ignorados", () => {
    expect(lerVotoDaEnquete(evento({ selectedOptions: [] }))).toBeNull();
    expect(lerVotoDaEnquete(evento({ fromMe: true }))).toBeNull();
    expect(lerVotoDaEnquete({ vote: {} })).toBeNull();
  });

  it("external_id determinístico: reentrega igual, voto trocado diferente", () => {
    const a = lerVotoDaEnquete(evento({}))!;
    const b = lerVotoDaEnquete(evento({}))!;
    const trocado = lerVotoDaEnquete(evento({ selectedOptions: ["Moradia"], timestamp: 1700000060 }))!;
    expect(externalIdDoVoto(a)).toBe(externalIdDoVoto(b));
    expect(externalIdDoVoto(trocado)).not.toBe(externalIdDoVoto(a));
  });
});
