/**
 * `loadRespostasDaEspera` (o adaptador Supabase do motor): o que conta como
 * resposta a um bloco de conversa. Banco em memória que filtra de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  inboundContaComoResposta,
  PREFIXO_DA_MARCA_DE_NAO_SUPORTADO,
} from "@/lib/automacoes/conversa";
import { marcaDeNaoSuportado } from "@/lib/channels/meta/webhook";

import { criarBancoEmMemoria, type Linha } from "../../tests/helpers/banco-em-memoria";
import { createSupabaseAdminClient } from "./engine";

const ORG = "org-1";
const C = "c-1";
const PISO = "2026-11-03T11:00:00.000Z";
const seg = (s: number) => new Date(Date.parse(PISO) + s * 1000).toISOString();

function msg(over: Linha): Linha {
  return {
    organization_id: ORG,
    contact_id: C,
    direction: "inbound",
    type: "text",
    body: "oi",
    metadata: {},
    ...over,
  };
}

function carregar(messages: Linha[]) {
  const banco = criarBancoEmMemoria({
    contacts: [{ id: C, organization_id: ORG, phone_number: null }],
    messages,
  });
  return createSupabaseAdminClient(banco as unknown as SupabaseClient).loadRespostasDaEspera!(
    ORG,
    C,
    PISO,
  );
}

describe("loadRespostasDaEspera", () => {
  it("reação e marca de tipo não suportado ficam de fora; mídia sem texto entra com texto vazio", async () => {
    const r = await carregar([
      msg({ id: "r", type: "reaction", body: "👍", sent_at: seg(1), created_at: seg(1) }),
      msg({ id: "u", body: marcaDeNaoSuportado("order"), sent_at: seg(2), created_at: seg(2) }),
      msg({ id: "a", type: "audio", body: null, sent_at: seg(3), created_at: seg(3) }),
      msg({
        id: "t",
        body: "2",
        metadata: { reply: { id: "invest" } },
        sent_at: seg(4),
        created_at: seg(4),
      }),
    ]);
    expect(r).toEqual([
      { texto: "", replyId: null },
      { texto: "2", replyId: "invest" },
    ]);
  });

  it("borda da folga: provedor 4 s atrás entra, 6 s atrás não; chegada antes do piso nunca entra", async () => {
    const r = await carregar([
      msg({ id: "seis", body: "seis", sent_at: seg(-6), created_at: seg(1) }),
      msg({ id: "quatro", body: "quatro", sent_at: seg(-4), created_at: seg(1) }),
      msg({ id: "antes", body: "antes", sent_at: seg(-1), created_at: seg(-1) }),
    ]);
    expect(r.map((x) => x.texto)).toEqual(["quatro"]);
  });

  it("a marca repetida no módulo do editor é a mesma do webhook do oficial", () => {
    expect(marcaDeNaoSuportado("qualquer").startsWith(PREFIXO_DA_MARCA_DE_NAO_SUPORTADO)).toBe(
      true,
    );
    expect(inboundContaComoResposta({ type: "text", body: marcaDeNaoSuportado("system") })).toBe(
      false,
    );
    expect(inboundContaComoResposta({ type: "reaction", body: "👍" })).toBe(false);
    expect(inboundContaComoResposta({ type: "image", body: null })).toBe(true);
  });
});
