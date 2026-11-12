import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota roda com o `requireRole` DE VERDADE: o que é dublado é a borda dele
 * (quem está logado, qual a organização ativa e o papel que o banco devolve) e
 * o banco da gravação, que aqui é uma tabela em memória que respeita os
 * filtros. Assim "outra organização não altera" é medido no estado da tabela,
 * não na lista de chamadas.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
  mfaEmDividaEstrita: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CANAL_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;
let tabela: Linha[];

function bancoEmMemoria() {
  return {
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      let mudanca: Linha | null = null;
      const b = {
        select: () => b,
        update: (v: Linha) => {
          mudanca = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return b;
        },
        is: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return b;
        },
        maybeSingle: async () => {
          const achadas = tabela.filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
          if (mudanca) for (const l of achadas) Object.assign(l, mudanca);
          return { data: achadas[0] ? { ...achadas[0] } : null, error: null };
        },
      };
      return b;
    },
  };
}

function papelNoBanco(role: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: role, error: null })),
  } as never);
}

function request(body: unknown, id = CANAL) {
  return new NextRequest(`http://localhost/api/v1/channel-sessions/${id}/name`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const chamar = (body: unknown, id = CANAL) =>
  PATCH(request(body, id), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  tabela = [
    {
      id: CANAL,
      organization_id: ORG,
      display_name: "WhatsApp",
      label_color: null,
      archived_at: null,
    },
    {
      id: CANAL_DA_OUTRA,
      organization_id: OUTRA_ORG,
      display_name: "Deles",
      label_color: null,
      archived_at: null,
    },
  ];
  vi.mocked(createAdminClient).mockReturnValue(bancoEmMemoria() as never);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USUARIO,
    is_platform_admin: false,
    support: null,
    organizations: [],
    idioma: "pt-BR",
  } as never);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG,
    name: "Empresa",
    role: "manager",
    org_status: "active",
  } as never);
  papelNoBanco("manager");
});

describe("PATCH …/channel-sessions/[id]/name (nome e cor da etiqueta)", () => {
  it("sem login: 401 e o banco não é tocado", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const r = await chamar({ display_name: "Ingrid" });
    expect(r.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("atendente (papel abaixo de gerente): 403 e nada muda", async () => {
    papelNoBanco("agent");
    const r = await chamar({ display_name: "Ingrid", label_color: "rosa" });
    expect(r.status).toBe(403);
    expect(tabela[0]).toMatchObject({ display_name: "WhatsApp", label_color: null });
  });

  it("gerente grava nome e cor, aparados, e audita as duas mudanças", async () => {
    const r = await chamar({ display_name: "  Ingrid Müller  ", label_color: "lavanda" });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: Linha };
    expect(corpo.data).toMatchObject({
      id: CANAL,
      display_name: "Ingrid Müller",
      label_color: "lavanda",
    });
    expect(tabela[0]).toMatchObject({ display_name: "Ingrid Müller", label_color: "lavanda" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.renamed",
        organizationId: ORG,
        resourceId: CANAL,
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.label_color_changed",
        organizationId: ORG,
        resourceId: CANAL,
        metadata: { previous_label_color: null, label_color: "lavanda" },
      }),
    );
  });

  it("só a cor: não renomeia e audita só a cor; null tira a cor", async () => {
    tabela[0]!.label_color = "menta";
    const r = await chamar({ label_color: null });
    expect(r.status).toBe(200);
    expect(tabela[0]).toMatchObject({ display_name: "WhatsApp", label_color: null });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.label_color_changed" }),
    );
  });

  it("sem mudança real: 200 e nenhuma auditoria", async () => {
    const r = await chamar({ display_name: "WhatsApp", label_color: null });
    expect(r.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("canal de outra organização: 404 e a linha dela não muda", async () => {
    const r = await chamar({ display_name: "Invadido", label_color: "coral" }, CANAL_DA_OUTRA);
    expect(r.status).toBe(404);
    expect(tabela[1]).toMatchObject({ display_name: "Deles", label_color: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é recusado (a organização vem da sessão)", async () => {
    const r = await chamar({ display_name: "X", organization_id: OUTRA_ORG });
    expect(r.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["nome vazio", { display_name: "   " }],
    ["nome com mais de 80 caracteres", { display_name: "a".repeat(81) }],
    ["cor fora da paleta", { label_color: "vermelho-sangue" }],
    ["cor em hex", { label_color: "#fce7f3" }],
    ["corpo sem nome nem cor", {}],
  ])("%s: 422 antes de tocar no banco", async (_caso, body) => {
    const r = await chamar(body);
    expect(r.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(tabela[0]).toMatchObject({ display_name: "WhatsApp", label_color: null });
  });
});
