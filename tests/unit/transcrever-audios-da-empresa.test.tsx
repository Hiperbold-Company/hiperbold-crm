import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O INTERRUPTOR "TRANSCREVER ÁUDIOS" DA EMPRESA (decisão do dono do produto,
 * 25/11/2026). Mora em `organizations.settings.crm.transcrever_audios`, em
 * Configurações › Atendimento, decidido por gerente para cima, e nasce LIGADO:
 * empresa sem a configuração transcreve como sempre. Desligado, o áudio fica na
 * conversa sem texto e o agente de IA não recebe transcrição (o corte é no
 * worker de mídia, `tests/unit/midia-grava-custo-em-llm-calls.test.ts`).
 *
 * O que se prova aqui: a régua do leitor central, a linha no catálogo de
 * recursos opcionais, o texto da tela e a gravação (papel, merge do jsonb,
 * auditoria).
 */

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  definir: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
// A tela chama a ação por este módulo; a gravação de verdade é testada abaixo
// pelo módulo real (`vi.importActual`).
vi.mock("@/app/actions/settings/definirTranscreverAudios", () => ({ definirTranscreverAudios: mocks.definir }));

import { transcreverAudiosLigado } from "@/lib/schemas/settings";
import { RECURSOS_OPCIONAIS, estadoDoRecurso } from "@/lib/recursos-opcionais/catalogo";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import type * as AcaoReal from "@/app/actions/settings/definirTranscreverAudios";
import { TranscreverAudios } from "@/app/app/settings/atendimento/_transcreverAudios";

describe("transcreverAudiosLigado: ausente liga, só o booleano false desliga", () => {
  it.each([
    [undefined, true],
    [null, true],
    [{}, true],
    [{ crm: {} }, true],
    [{ crm: { transcrever_audios: true } }, true],
    [{ crm: { transcrever_audios: "false" } }, true],
    [{ crm: { transcrever_audios: false } }, false],
    [{ crm: { transcrever_audios: false, team_contact_tags: "lixo" } }, false],
  ])("%j → %s", (settings, esperado) => {
    expect(transcreverAudiosLigado(settings)).toBe(esperado);
  });
});

describe("a chave entra no catálogo de recursos opcionais da empresa", () => {
  const recurso = RECURSOS_OPCIONAIS.find((r) => r.id === "transcrever_audios");

  it("nível organização, padrão ligado, gerente decide, em Configurações › Atendimento", () => {
    expect(recurso).toMatchObject({
      nivel: "organizacao",
      padrao: "ligado",
      quemDecide: "manager",
      href: "/app/settings/atendimento",
    });
  });

  it("lê o estado pela mesma régua do worker", () => {
    const fontes = { modulos: [], servidor: {}, telefonia: null };
    expect(estadoDoRecurso(recurso!, { ...fontes, settings: {} })).toBe("ligado");
    expect(estadoDoRecurso(recurso!, { ...fontes, settings: { crm: { transcrever_audios: false } } })).toBe("desligado");
    expect(estadoDoRecurso(recurso!, { ...fontes, settings: null })).toBe("nao_lido");
  });
});

describe("a tela", () => {
  it("diz o que acontece ligado e desligado, e grava pelo interruptor", async () => {
    mocks.definir.mockResolvedValue({ ok: true });
    render(<TranscreverAudios ligada={true} podeMudar={true} idioma="pt-BR" />);
    expect(screen.getByText("Transcrever áudios")).toBeVisible();
    expect(screen.getByText("Ligado: os áudios recebidos e a fala dos vídeos viram texto na conversa, e o agente de IA lê a transcrição.")).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Transcrever áudios" }));
    await waitFor(() => expect(mocks.definir).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(
        screen.getByText("Desligado: o áudio e a fala dos vídeos ficam na conversa sem texto, e o agente de IA não recebe a transcrição (os vídeos ainda são lidos pelas imagens)."),
      ).toBeVisible(),
    );
  });

  it("quem não pode mudar vê o interruptor travado", () => {
    render(<TranscreverAudios ligada={false} podeMudar={false} idioma="pt-BR" />);
    expect(screen.getByRole("switch", { name: "Transcrever áudios" })).toBeDisabled();
  });

  it("os textos novos têm tradução em espanhol e inglês", () => {
    for (const texto of [
      "Transcrever áudios",
      "Ligado: os áudios recebidos e a fala dos vídeos viram texto na conversa, e o agente de IA lê a transcrição.",
      "Desligado: o áudio e a fala dos vídeos ficam na conversa sem texto, e o agente de IA não recebe a transcrição (os vídeos ainda são lidos pelas imagens).",
    ]) {
      expect(DICIONARIO[texto], texto).toBeDefined();
      expect(traduzir(texto, "en")).not.toBe(texto);
      expect(traduzir(texto, "es")).not.toBe(texto);
    }
  });
});

describe("definirTranscreverAudios", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
  let updates: unknown[];
  let definirTranscreverAudios: typeof AcaoReal.definirTranscreverAudios;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ definirTranscreverAudios } = await vi.importActual<typeof AcaoReal>(
      "@/app/actions/settings/definirTranscreverAudios",
    ));
    updates = [];
    mocks.loadAuthUser.mockResolvedValue(USER);
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "manager" });
    mocks.mfaEmDivida.mockResolvedValue(false);
    mocks.createAdminClient.mockReturnValue({
      from() {
        let payload: unknown = null;
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.update = (p: unknown) => {
          payload = p;
          return b;
        };
        b.eq = () => b;
        b.maybeSingle = async () => {
          if (payload !== null) {
            updates.push(payload);
            return { data: { id: ORG }, error: null };
          }
          return { data: { settings: { branding: { accent_hex: "#123456" }, crm: { team_contact_tags: ["x"] } } }, error: null };
        };
        return b;
      },
    });
  });

  it.each(["viewer", "agent"])("%s é recusado e nada é gravado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role });
    const r = await definirTranscreverAudios(false);
    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("gerente grava a chave sem perder o resto do settings e audita", async () => {
    const r = await definirTranscreverAudios(false);
    expect(r).toEqual({ ok: true });
    expect(updates).toEqual([
      { settings: { branding: { accent_hex: "#123456" }, crm: { team_contact_tags: ["x"], transcrever_audios: false } } },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm.transcrever_audios_alterado",
        organizationId: ORG,
        actorUserId: USER.id,
        metadata: { ligado: false },
      }),
    );
  });

  it("entrada que não é booleano é recusada", async () => {
    const r = await definirTranscreverAudios("false" as unknown as boolean);
    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
  });
});
