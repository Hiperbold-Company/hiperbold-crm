import { describe, expect, it } from "vitest";

import { emitirEstado } from "@/lib/agenda/google/estado";
import {
  VALIDADE_DO_ESTADO_MS,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
  verificarEstadoMetaSocial,
  vinculoMetaSocialConfere,
} from "@/lib/channels/meta-social/estado";

const SEGREDO = "segredo-interno-com-mais-de-16";
const agora = new Date("2026-11-02T12:00:00Z");
const dados = {
  plataforma: "instagram" as const,
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authSessionId: "33333333-3333-4333-8333-333333333333",
};

describe("state do OAuth social", () => {
  it("o state emitido volta com organização, usuário, sessão e nonce", () => {
    const s = emitirEstadoMetaSocial(dados, { segredo: SEGREDO, agora, nonce: "n1" });
    expect(verificarEstadoMetaSocial(s, { segredo: SEGREDO, agora, plataforma: "instagram" })).toMatchObject({
      organizationId: dados.organizationId,
      userId: dados.userId,
      authSessionId: dados.authSessionId,
      nonce: "n1",
    });
  });

  it("vencido não vale", () => {
    const s = emitirEstadoMetaSocial(dados, { segredo: SEGREDO, agora });
    const depois = new Date(agora.getTime() + VALIDADE_DO_ESTADO_MS + 1);
    expect(verificarEstadoMetaSocial(s, { segredo: SEGREDO, agora: depois, plataforma: "instagram" })).toBeNull();
  });

  it("state do Instagram não conclui o Messenger", () => {
    const s = emitirEstadoMetaSocial(dados, { segredo: SEGREDO, agora });
    expect(verificarEstadoMetaSocial(s, { segredo: SEGREDO, agora, plataforma: "messenger" })).toBeNull();
  });

  it("state da agenda do Google, assinado com o MESMO segredo, não passa aqui", () => {
    const google = emitirEstado(
      { organizationId: dados.organizationId, userId: dados.userId },
      { segredo: SEGREDO, agora },
    );
    expect(verificarEstadoMetaSocial(google, { segredo: SEGREDO, agora, plataforma: "instagram" })).toBeNull();
  });

  it("carga adulterada ou segredo diferente não vale", () => {
    const s = emitirEstadoMetaSocial(dados, { segredo: SEGREDO, agora });
    const [carga, assinatura] = s.split(".");
    const outra = Buffer.from(
      Buffer.from(carga!, "base64url").toString().replace(dados.organizationId, "99999999-9999-4999-8999-999999999999"),
    ).toString("base64url");
    expect(verificarEstadoMetaSocial(`${outra}.${assinatura}`, { segredo: SEGREDO, agora, plataforma: "instagram" })).toBeNull();
    expect(verificarEstadoMetaSocial(s, { segredo: `${SEGREDO}x`, agora, plataforma: "instagram" })).toBeNull();
  });
});

describe("cookie de vínculo", () => {
  it("confere só com o nonce do state", () => {
    const cookie = assinarVinculoMetaSocial("nonce-a", SEGREDO);
    expect(vinculoMetaSocialConfere(cookie, "nonce-a", SEGREDO)).toBe(true);
    expect(vinculoMetaSocialConfere(cookie, "nonce-b", SEGREDO)).toBe(false);
    expect(vinculoMetaSocialConfere(undefined, "nonce-a", SEGREDO)).toBe(false);
  });
});
