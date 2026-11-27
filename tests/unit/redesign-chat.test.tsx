/**
 * O CHAT NO REDESIGN (item B4) — desligado é a tela de sempre, ligado é a nova.
 *
 * A tela do Chat não foi duplicada: os componentes de `components/inbox` ganham
 * `data-rd-chat="<peça>"` SÓ com a chave ligada (`useMarcaDoChat`), e o bloco
 * "redesign: chat" de `app/globals.css` os desenha. As duas metades da
 * garantia "desligado não muda nada" são provadas aqui:
 *
 *   1. DOM — sem o provedor do redesign (a chave desligada), nenhum atributo
 *      do redesign é escrito; com ele, as peças aparecem.
 *   2. CSS — toda regra do bloco começa por `[data-redesign="ligado"]`, que o
 *      `<html>` só tem com a chave ligada. Desligada, nenhuma casa.
 *
 * O que este teste NÃO prova: a aparência. jsdom não pinta; a semelhança com o
 * protótipo v49 só se confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";
import { corDoAvatar, CORES_DO_AVATAR } from "@/components/inbox/redesign/marca";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Message } from "@/lib/types/messaging";

const ATRIBUTOS_DO_REDESIGN = "[data-rd-chat],[data-rd-cor],[data-rd-de],[data-rd-modo],[data-rd-apagada]";

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-09-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("Chat no redesign — item da lista", () => {
  const item = (
    <ConversationListItem conversation={conversaDeExemplo.conversation} {...conversaDeExemplo.props} isSelected />
  );

  it("desligado: nenhum atributo do redesign (a linha de sempre)", () => {
    const { container } = render(item);
    expect(container.querySelectorAll(ATRIBUTOS_DO_REDESIGN)).toHaveLength(0);
    expect(container.querySelector("[data-conversation-id]")).not.toBeNull();
  });

  it("ligado: as peças do protótipo aparecem, no mesmo botão de sempre", () => {
    const { container } = render(item, { wrapper: ligado });
    for (const peca of ["linha", "item", "marca-aberta", "avatar", "ponto", "nome", "hora", "previa"]) {
      expect(container.querySelector(`[data-rd-chat="${peca}"]`), peca).not.toBeNull();
    }
    const cor = Number(container.querySelector('[data-rd-chat="avatar"]')!.getAttribute("data-rd-cor"));
    expect(cor).toBeGreaterThanOrEqual(0);
    expect(cor).toBeLessThan(CORES_DO_AVATAR);
    expect(container.querySelector('[data-rd-chat="item"]')).toHaveAttribute(
      "data-conversation-id",
      conversaDeExemplo.conversation.id,
    );
  });

  it("a cor do avatar é estável pelo id", () => {
    expect(corDoAvatar("contato-1")).toBe(corDoAvatar("contato-1"));
  });
});

describe("Chat no redesign — bolha", () => {
  it("desligado: a bolha de sempre, sem atributo do redesign", () => {
    const { container } = render(<MessageBubble message={msg({ sent_via: "ai" })} />);
    expect(screen.getByTestId("message-bubble")).toBeInTheDocument();
    expect(container.querySelectorAll(ATRIBUTOS_DO_REDESIGN)).toHaveLength(0);
  });

  it("ligado: a bolha diz de quem é — cliente, IA ou equipe", () => {
    const de = (m: Message) => {
      const { unmount } = render(<MessageBubble message={m} />, { wrapper: ligado });
      const valor = screen.getByTestId("message-bubble").getAttribute("data-rd-de");
      unmount();
      return valor;
    };
    expect(de(msg({ direction: "inbound", sent_via: null as unknown as Message["sent_via"] }))).toBe("cliente");
    expect(de(msg({ sent_via: "ai" }))).toBe("ia");
    expect(de(msg({ sent_via: "user" }))).toBe("equipe");
  });
});

describe("Chat no redesign — o CSS só vale com a chave ligada", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const inicio = css.indexOf("/* redesign: chat ─");
  const fim = css.indexOf("/* redesign: chat — fim");

  it("o bloco existe, uma vez só", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    expect(css.indexOf("/* redesign: chat ─", inicio + 1)).toBe(-1);
  });

  it('toda regra do bloco começa por [data-redesign="ligado"]', () => {
    const bloco = css.slice(inicio, fim).replace(/\/\*[\s\S]*?\*\//g, "");
    const seletores = [...bloco.matchAll(/([^{};]+)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => s && !s.startsWith("@"))
      .flatMap((s) => s.split(",").map((p) => p.trim()));
    expect(seletores.length).toBeGreaterThan(40);
    expect(seletores.filter((s) => !s.startsWith('[data-redesign="ligado"]'))).toEqual([]);
  });

  it("claro e escuro declaram as mesmas variáveis", () => {
    const bloco = css.slice(inicio, fim);
    const chaves = (seletor: string) => {
      const i = bloco.indexOf(seletor);
      expect(i, seletor).toBeGreaterThan(-1);
      const corpo = bloco.slice(bloco.indexOf("{", i) + 1, bloco.indexOf("}", i));
      return [...corpo.matchAll(/(--rd-chat-[\w-]+)\s*:/g)].map((m) => m[1]).sort();
    };
    const claro = chaves('[data-redesign="ligado"] [data-theme="light"] {');
    const escuro = chaves('[data-redesign="ligado"] [data-theme="dark"] {');
    expect(claro.length).toBeGreaterThan(5);
    expect(escuro).toEqual(claro);
  });
});
