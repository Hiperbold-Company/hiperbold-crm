import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { mudarPapelDoMembro, revogarAcessoDoMembro, type DepsDeEquipe } from "@/lib/team/administracao";

/**
 * Membro da agência (migration 0974): as rotas de equipe e as tools MCP gravam com o cliente de serviço, que passa
 * pelo gatilho do banco. A recusa do papel e da revogação do membro da agência mora no código e precisa valer antes
 * de qualquer escrita.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";

function deps(alvo: Record<string, unknown> | null) {
  const escreveu = vi.fn();
  const consulta: Record<string, unknown> = {};
  consulta.select = () => consulta;
  consulta.eq = () => consulta;
  consulta.maybeSingle = async () => ({ data: alvo, error: null });
  const admin = { from: () => ({ update: escreveu, delete: escreveu }) };
  const d = {
    supabase: { from: () => consulta },
    admin,
    organizationId: ORG,
    actor: { kind: "user", userId: ADMIN },
    responsavel: ADMIN,
    requestId: "req-1",
  } as unknown as DepsDeEquipe;
  return { d, escreveu };
}

const AGENCIA = { id: "v1", user_id: ALVO, role: "admin", revoked_at: null, membro_da_agencia: true };

describe("rotas de equipe recusam o membro da agência", () => {
  it("mudar o papel: 403 e nenhuma escrita", async () => {
    const { d, escreveu } = deps(AGENCIA);
    const erro = await mudarPapelDoMembro(d, ALVO, "viewer").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(403);
    expect(escreveu).not.toHaveBeenCalled();
  });

  it("revogar o acesso: 403 e nenhuma escrita", async () => {
    const { d, escreveu } = deps(AGENCIA);
    const erro = await revogarAcessoDoMembro(d, ALVO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(403);
    expect(escreveu).not.toHaveBeenCalled();
  });

  it("controle: membro comum NÃO é recusado pela regra da agência (chega à escrita)", async () => {
    const { d } = deps({ ...AGENCIA, role: "agent", membro_da_agencia: false });
    // O dublê não implementa a cadeia de escrita; basta provar que o erro NÃO é o 403 da agência.
    const erro = await mudarPapelDoMembro(d, ALVO, "manager").catch((e: unknown) => e);
    expect(erro instanceof ApiError && erro.status === 403).toBe(false);
  });
});
