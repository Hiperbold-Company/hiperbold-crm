/**
 * /admin/sistema/falhas-do-plano — a tela de `billing_trigger_alarmes` (D-074).
 *
 * O que se prova:
 *   1. a GUARDA: quem não é admin da plataforma recebe 404 e o client de
 *      serviço nem é aberto (a tabela tem falhas de todas as organizações);
 *   2. o ESTADO VAZIO diz "Nenhuma falha registrada.";
 *   3. leitura que falhou NÃO vira estado vazio;
 *   4. a lista mostra quando, o nome da organização, o que falhou em português
 *      e a mensagem, pede do mais novo para o mais velho e pagina.
 *
 * O que é dublê: só o banco (o client do Supabase). A leitura de
 * `lib/billing/alarmes-de-gatilho.ts` e a página são as de verdade.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Usuario = { is_platform_admin: boolean; idioma: "pt-BR" } | null;

const h = vi.hoisted(() => ({
  usuario: null as Usuario,
  alarmes: [] as Record<string, unknown>[],
  erroAlarmes: null as { message: string } | null,
  orgs: [] as { id: string; name: string }[],
  chamadas: [] as { tabela: string; metodo: string; args: unknown[] }[],
  abriuAdmin: 0,
}));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => h.usuario }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** Dublê mínimo do query builder do PostgREST: encadeia e resolve no `await`. */
function fakeAdmin() {
  h.abriuAdmin += 1;
  return {
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      for (const metodo of ["select", "order", "range", "in", "gte"]) {
        q[metodo] = (...args: unknown[]) => {
          h.chamadas.push({ tabela, metodo, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => void) => {
        if (tabela === "billing_trigger_alarmes") {
          const range = h.chamadas.filter((c) => c.tabela === tabela && c.metodo === "range").at(-1);
          const [de, ate] = (range?.args ?? [0, 0]) as [number, number];
          resolve({ data: h.erroAlarmes ? null : h.alarmes.slice(de, ate + 1), error: h.erroAlarmes });
        } else if (tabela === "organizations") {
          resolve({ data: h.orgs, error: null });
        } else resolve({ data: null, error: { message: `tabela inesperada ${tabela}` } });
      };
      return q;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));

import Page from "@/app/admin/(protected)/sistema/falhas-do-plano/page";

const ORG = "11111111-1111-4111-8111-111111111111";

function linha(i: number) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    organization_id: ORG,
    gatilho: "fn_billing_trava_crm_leads",
    falha: `canceling statement due to lock timeout #${i}`,
    criado_em: new Date(Date.UTC(2026, 10, 12, 12, 0, 0) - i * 60_000).toISOString(),
  };
}

async function abrir(pagina?: string) {
  const el = await Page({ searchParams: Promise.resolve(pagina ? { pagina } : {}) });
  return render(el);
}

beforeEach(() => {
  h.usuario = { is_platform_admin: true, idioma: "pt-BR" };
  h.alarmes = [];
  h.erroAlarmes = null;
  h.orgs = [{ id: ORG, name: "Clínica Sorriso" }];
  h.chamadas = [];
  h.abriuAdmin = 0;
});

afterEach(cleanup);

describe("/admin/sistema/falhas-do-plano — a guarda", () => {
  it("quem não é admin da plataforma recebe 404 e o banco não é aberto", async () => {
    h.usuario = { is_platform_admin: false, idioma: "pt-BR" };
    await expect(abrir()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.abriuAdmin).toBe(0);
  });

  it("sem sessão também é 404", async () => {
    h.usuario = null;
    await expect(abrir()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.abriuAdmin).toBe(0);
  });
});

describe("/admin/sistema/falhas-do-plano — o que a tela mostra", () => {
  it("sem nenhuma linha: estado vazio", async () => {
    await abrir();
    expect(screen.getByText("Nenhuma falha registrada.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("leitura que falhou não se passa por vazio", async () => {
    h.erroAlarmes = { message: "permission denied" };
    await abrir();
    expect(screen.getByRole("alert").textContent).toContain("Não foi possível ler as falhas agora.");
    expect(screen.queryByText("Nenhuma falha registrada.")).toBeNull();
  });

  it("lista com nome da organização, o que falhou em português e a mensagem, do mais novo", async () => {
    h.alarmes = [linha(1), linha(2)];
    await abrir();
    expect(screen.getAllByRole("link", { name: "Clínica Sorriso" })[0]?.getAttribute("href")).toBe(
      `/admin/tenants/${ORG}/plano`,
    );
    expect(screen.getAllByText("Contagem de leads abertos")).toHaveLength(2);
    expect(screen.getByText("canceling statement due to lock timeout #1")).toBeTruthy();
    const ordens = h.chamadas.filter((c) => c.tabela === "billing_trigger_alarmes" && c.metodo === "order");
    expect(ordens[0]?.args).toEqual(["criado_em", { ascending: false }]);
    // Duas linhas: sem paginação.
    expect(screen.queryByRole("link", { name: "Próxima" })).toBeNull();
  });

  it("nome da organização ausente: mostra o começo do id, sem quebrar", async () => {
    h.alarmes = [linha(1)];
    h.orgs = [];
    await abrir();
    expect(screen.getByRole("link", { name: ORG.slice(0, 8) })).toBeTruthy();
  });

  it("gatilho desconhecido aparece pelo nome técnico", async () => {
    h.alarmes = [{ ...linha(1), gatilho: "fn_outro_gatilho" }];
    await abrir();
    expect(screen.getByText("fn_outro_gatilho")).toBeTruthy();
  });

  it("pagina de 50 em 50: 51 linhas mostram 50 e o link para a próxima", async () => {
    h.alarmes = Array.from({ length: 51 }, (_, i) => linha(i + 1));
    await abrir();
    expect(screen.getAllByText("Contagem de leads abertos")).toHaveLength(50);
    expect(screen.getByRole("link", { name: "Próxima" }).getAttribute("href")).toBe(
      "/admin/sistema/falhas-do-plano?pagina=2",
    );
    expect(screen.queryByRole("link", { name: "Anterior" })).toBeNull();
  });

  it("segunda página: pede a partir da 51ª linha e oferece voltar", async () => {
    h.alarmes = Array.from({ length: 51 }, (_, i) => linha(i + 1));
    await abrir("2");
    expect(screen.getAllByText("Contagem de leads abertos")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe(
      "/admin/sistema/falhas-do-plano?pagina=1",
    );
  });

  it("página inválida na URL cai na primeira", async () => {
    h.alarmes = [linha(1)];
    await abrir("abc");
    const range = h.chamadas.find((c) => c.tabela === "billing_trigger_alarmes" && c.metodo === "range");
    expect(range?.args).toEqual([0, 50]);
  });
});
