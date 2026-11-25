import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opções nativas na UAZAPI: o corpo exato de `/send/menu`, a reserva em texto
 * numerado e o clique que volta pelo webhook.
 *
 * Dublê só no `fetch` (o servidor da instância) e nas bordas que o teste do
 * adapter já dubla (cliente de serviço, credencial, régua de IP).
 *
 * SABOTAGEM: trocar `titulo|id` por `id|titulo` derruba o formato; cair para o
 * texto em erro de REDE faz "rede não reenvia" ficar vermelho; tirar o
 * `reply` do parse faz o clique voltar sem id.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));
vi.mock("@/lib/channels/uazapi/credentials", () => ({
  resolveUazapiCreds: async () => ({ instanceId: "inst", baseUrl: "https://empresa.uazapi.com", token: "tok" }),
}));

import { uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { corpoDoMenuUazapi, respostaDeOpcaoUazapi } from "@/lib/channels/uazapi/menu";
import { parseUazapiMensagem } from "@/lib/channels/uazapi/webhook";
import { casarRespostaComOpcao } from "@/lib/channels/opcoes-numeradas";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { OutboundInteractive } from "@/lib/channels/types";

const ORG = "00000000-0000-4000-8000-000000000999";
const BOTOES: OutboundInteractive = {
  kind: "buttons",
  items: [
    { id: "opcao_1", label: "Moradia" },
    { id: "opcao_2", label: "Investimento" },
  ],
};
const LISTA: OutboundInteractive = {
  kind: "list",
  button_label: "Ver bairros",
  items: [
    { id: "opcao_1", label: "Centro", description: "até 2 quartos" },
    { id: "opcao_2", label: "Praia" },
  ],
};

function resposta(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: "", headers: { get: () => null }, json: async () => json };
}
const url = (i: number) => String(fetchMock.mock.calls[i]?.[0] ?? "");
const corpo = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]?.[1] as { body?: string }).body)) as Record<string, unknown>;
const envelope = (interactive: OutboundInteractive, extra: Record<string, unknown> = {}) =>
  ({ organizationId: ORG, sessionRef: "inst", to: "553591485627", kind: "text", body: "Qual o objetivo?", interactive, ...extra }) as never;

beforeEach(() => fetchMock.mockReset());

describe("UAZAPI — formato do /send/menu", () => {
  it("botões: type button e choices `titulo|id`", () => {
    expect(corpoDoMenuUazapi("5535", "Qual?", BOTOES)).toEqual({
      number: "5535",
      text: "Qual?",
      type: "button",
      choices: ["Moradia|opcao_1", "Investimento|opcao_2"],
    });
  });

  it("lista: type list, listButton e choices `titulo|id|descrição`; citação vira replyid", () => {
    expect(corpoDoMenuUazapi("5535", "Onde?", LISTA, "ABC")).toEqual({
      number: "5535",
      text: "Onde?",
      replyid: "ABC",
      type: "list",
      listButton: "Ver bairros",
      choices: ["Centro|opcao_1|até 2 quartos", "Praia|opcao_2"],
    });
  });

  it("rótulo com `|`, quebra de linha ou `[` no começo não cabe no formato", () => {
    const com = (label: string): OutboundInteractive => ({ kind: "buttons", items: [{ id: "opcao_1", label }] });
    expect(corpoDoMenuUazapi("5535", "x", com("A|B"))).toBeNull();
    expect(corpoDoMenuUazapi("5535", "x", com("A\nB"))).toBeNull();
    expect(corpoDoMenuUazapi("5535", "x", com("[Seção]"))).toBeNull();
  });

  it("a matriz declara opções nativas para a UAZAPI", () => {
    expect(capabilitiesOf("uazapi").interactive).toBe("native");
  });
});

describe("UAZAPI — envio e reserva", () => {
  it("menu aceito: uma chamada só, em /send/menu, com o id devolvido", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { messageid: "3EB0MENU" }));
    const r = await uazapiAdapter.send(envelope(BOTOES));
    expect(r).toEqual({ externalId: "3EB0MENU" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(0)).toBe("https://empresa.uazapi.com/send/menu");
    expect(corpo(0)).toMatchObject({ type: "button", choices: ["Moradia|opcao_1", "Investimento|opcao_2"] });
  });

  it("menu recusado pelo servidor: manda o texto numerado e avisa", async () => {
    fetchMock.mockResolvedValueOnce(resposta(400, { error: "menu not supported" }));
    fetchMock.mockResolvedValueOnce(resposta(200, { messageid: "3EB0TXT" }));
    const r = await uazapiAdapter.send(envelope(BOTOES));
    expect(r).toEqual({ externalId: "3EB0TXT", opcoesComoTexto: true });
    expect(url(1)).toBe("https://empresa.uazapi.com/send/text");
    expect(corpo(1).text).toBe("Qual o objetivo?\n\n1) Moradia\n2) Investimento");
  });

  it("menu com 500, 408 ou 429: sobe o erro e NÃO reenvia como texto", async () => {
    for (const status of [500, 408, 429]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(resposta(status, { error: "ocupado" }));
      await expect(uazapiAdapter.send(envelope(BOTOES))).rejects.toThrow(`uazapi_send_failed: ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("menu com 422: reserva em texto numerado", async () => {
    fetchMock.mockResolvedValueOnce(resposta(422, { error: "invalid choices" }));
    fetchMock.mockResolvedValueOnce(resposta(200, { messageid: "3EB0TXT" }));
    expect(await uazapiAdapter.send(envelope(BOTOES))).toEqual({ externalId: "3EB0TXT", opcoesComoTexto: true });
  });

  it("opções que não cabem no menu: vai direto o texto numerado", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { messageid: "3EB0TXT" }));
    const r = await uazapiAdapter.send(envelope({ kind: "buttons", items: [{ id: "opcao_1", label: "A|B" }] }));
    expect(r.opcoesComoTexto).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(0)).toContain("/send/text");
  });

  it("erro de REDE no menu não reenvia como texto (pode ter saído)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(uazapiAdapter.send(envelope(BOTOES))).rejects.toThrow("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("UAZAPI — o clique volta como a resposta de texto", () => {
  const env = (message: Record<string, unknown>) =>
    ({
      EventType: "messages",
      message: { chatid: "553591485627@s.whatsapp.net", messageid: "3EB0CLIQUE", fromMe: false, ...message },
      chat: {},
    }) as never;

  it("botão tocado: texto = título, reply.id = id da opção, e casa com a opção oferecida", () => {
    const r = parseUazapiMensagem(env({ messageType: "ButtonsResponseMessage", text: "Investimento", buttonOrListid: "opcao_2" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.msg.text).toBe("Investimento");
    expect(r.msg.reply).toEqual({ id: "opcao_2", title: "Investimento", kind: "button_reply" });
    expect(casarRespostaComOpcao({ texto: r.msg.text, replyId: r.msg.reply?.id }, BOTOES.items)).toBe("opcao_2");
  });

  it("item de lista sem `text`, só no content: não some e vira list_reply", () => {
    const r = parseUazapiMensagem(
      env({ messageType: "ListResponseMessage", content: { title: "Praia", singleSelectReply: { selectedRowId: "opcao_2" } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.msg.tipo).toBe("text");
    expect(r.msg.text).toBe("Praia");
    expect(r.msg.reply).toEqual({ id: "opcao_2", title: "Praia", kind: "list_reply" });
  });

  it("mensagem comum não ganha reply", () => {
    expect(respostaDeOpcaoUazapi({ messageType: "Conversation", text: "oi" })).toBeNull();
    const r = parseUazapiMensagem(env({ messageType: "Conversation", text: "1" }));
    expect(r.ok && r.msg.reply).toBeUndefined();
  });

  it("resposta numerada digitada casa pelo número", () => {
    expect(casarRespostaComOpcao({ texto: "2" }, BOTOES.items)).toBe("opcao_2");
  });
});
