/**
 * O VIGIA NÃO GRITA POR UM SOLUÇO DE REDE.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * O vigia de conexões roda de 5 em 5 minutos. Uma única rodada sem resposta do
 * servidor de WhatsApp ("fetch failed", "servidor_respondeu_503", timeout)
 * abria o aviso "Não foi possível verificar a conexão" e mandava e-mail aos
 * admins; a rodada seguinte respondia e saía o e-mail "voltou". Foram 11 pares
 * de e-mail em 10 dias para uma conexão que nunca saiu de `WORKING`.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Pela rota do cron de verdade, rodada após rodada, com a regra de aviso de
 * verdade (`lib/channels/health.ts`) e um banco em memória: só o servidor de
 * WhatsApp (o adapter) e o envio do e-mail são dublês.
 *
 *   - 1 ou 2 rodadas sem resposta seguidas de resposta: zero e-mail, zero aviso;
 *   - 3 seguidas: 1 e-mail de "não foi possível verificar"; depois responde: 1 "voltou";
 *   - QR para escanear, sessão parada e credencial recusada: aviso na 1ª rodada;
 *   - o contador zera quando o servidor responde.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";

const SEGREDO = "segredo-do-vigia";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

const emails: Array<{ tipo: string; titulo?: string }> = [];
vi.mock("@/lib/channels/aviso-por-email", () => ({
  avisarConexaoPorEmail: vi.fn(async (_admin: unknown, args: { evento: { tipo: string; titulo?: string } }) => {
    emails.push(args.evento);
    return "enviado";
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** O que o servidor de WhatsApp responde em cada rodada, na ordem. */
type Resposta = { reachable: boolean; status: string | null; detail: string | null };
let roteiro: Resposta[] = [];

vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof Canais>()),
  getAdapter: () => ({
    checkHealth: async () => {
      const r = roteiro.shift();
      if (!r) throw new Error("roteiro acabou");
      return r;
    },
  }),
  resolveSessionRef: () => "ref-da-sessao",
}));

// ─── Banco em memória, só o que o vigia e a regra de aviso usam ─────────────

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]> = {};

function construtor(tabela: string) {
  const filtros: Array<[string, unknown]> = [];
  let op: "select" | "update" | "insert" | "upsert" = "select";
  let carga: Linha = {};

  const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
  const executar = () => {
    const linhas = (tabelas[tabela] ??= []);
    if (op === "update") {
      for (const l of linhas) if (casa(l)) Object.assign(l, carga);
      return { data: null, error: null };
    }
    if (op === "insert") {
      // `agent_inbox_items.status` nasce `open` pelo default da coluna.
      linhas.push(tabela === "agent_inbox_items" ? { status: "open", ...carga } : { ...carga });
      return { data: null, error: null };
    }
    if (op === "upsert") {
      const existente = linhas.find(
        (l) =>
          l.organization_id === carga.organization_id &&
          l.channel_session_id === carga.channel_session_id,
      );
      if (existente) Object.assign(existente, carga);
      else linhas.push({ ...carga });
      return { data: null, error: null };
    }
    return { data: linhas.filter(casa).map((l) => ({ ...l })), error: null };
  };

  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return b;
    },
    is: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return b;
    },
    limit: async () => executar(),
    maybeSingle: async () => {
      const r = executar();
      return { data: (r.data as Linha[] | null)?.[0] ?? null, error: null };
    },
    update: (p: Linha) => {
      op = "update";
      carga = p;
      return b;
    },
    insert: (p: Linha) => {
      op = "insert";
      carga = p;
      return b;
    },
    upsert: (p: Linha) => {
      op = "upsert";
      carga = p;
      return b;
    },
    then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      Promise.resolve(executar()).then(ok, erro),
  };
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => construtor(t) }),
}));

// ─── Roteiro ────────────────────────────────────────────────────────────────

const respondeu: Resposta = { reachable: true, status: "WORKING", detail: null };
const semResposta = (detail = "fetch failed"): Resposta => ({ reachable: false, status: null, detail });

async function rodada(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  const json = (await res.json()) as { data?: Record<string, unknown> };
  expect(res.status).toBe(200);
  return json.data ?? {};
}

async function rodar(respostas: Resposta[]): Promise<void> {
  roteiro = [...respostas];
  for (let i = 0; i < respostas.length; i++) await rodada();
  expect(roteiro, "o roteiro não foi consumido inteiro").toHaveLength(0);
}

const sessao = () => tabelas.channel_sessions?.[0] ?? {};
const avisosAbertos = () => (tabelas.agent_inbox_items ?? []).filter((a) => a.status !== "resolved");
const emailsDe = (tipo: string) => emails.filter((e) => e.tipo === tipo);

beforeEach(() => {
  emails.length = 0;
  roteiro = [];
  tabelas = {
    channel_sessions: [
      {
        id: "sess-1",
        organization_id: "org-1",
        status: "WORKING",
        display_name: "Vendas",
        phone_number: null,
        archived_at: null,
        pareamento_qr_estado: null,
        consecutive_health_fails: 0,
      },
    ],
    channel_session_health: [],
    agent_inbox_items: [],
  };
});

describe("falha de rede passageira não avisa ninguém", () => {
  it("1 rodada sem resposta e depois resposta: zero e-mail, nada na Central", async () => {
    await rodar([semResposta(), respondeu]);
    expect(emails).toHaveLength(0);
    expect(tabelas.agent_inbox_items).toHaveLength(0);
  });

  it("2 rodadas sem resposta e depois resposta: zero e-mail, nada na Central", async () => {
    await rodar([semResposta("servidor_respondeu_503"), semResposta("The operation was aborted due to timeout"), respondeu]);
    expect(emails).toHaveLength(0);
    expect(tabelas.agent_inbox_items).toHaveLength(0);
  });

  it("o padrão medido em produção (falha, volta, falha, volta…) não gera e-mail", async () => {
    await rodar([semResposta(), respondeu, semResposta(), semResposta(), respondeu, semResposta(), respondeu]);
    expect(emails).toHaveLength(0);
  });
});

describe("falha que persiste avisa uma vez, e a volta também", () => {
  it("3 seguidas: 1 e-mail de 'não foi possível verificar' e 1 aviso na Central", async () => {
    await rodar([semResposta(), semResposta(), semResposta()]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(emailsDe("caiu")[0]?.titulo).toMatch(/Não foi possível verificar a conexão "Vendas"/);
    expect(avisosAbertos()).toHaveLength(1);
    expect(avisosAbertos()[0]).toMatchObject({ severity: "warn", ref_id: "sess-1" });
  });

  it("a 4ª e a 5ª rodada sem resposta não repetem o e-mail", async () => {
    await rodar([semResposta(), semResposta(), semResposta(), semResposta(), semResposta()]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(tabelas.agent_inbox_items).toHaveLength(1);
  });

  it("depois de avisar, a resposta manda 1 'voltou' e fecha o aviso", async () => {
    await rodar([semResposta(), semResposta(), semResposta(), respondeu]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(emailsDe("voltou")).toHaveLength(1);
    expect(avisosAbertos()).toHaveLength(0);
  });
});

describe("queda certa continua avisando na hora", () => {
  it("QR para escanear na 1ª rodada: aviso crítico e e-mail na hora", async () => {
    await rodar([{ reachable: true, status: "SCAN_QR_CODE", detail: null }]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(avisosAbertos()[0]).toMatchObject({ kind: "qr_rescan", severity: "critical" });
  });

  it("sessão parada/deslogada na 1ª rodada: aviso crítico na hora", async () => {
    await rodar([{ reachable: true, status: "STOPPED", detail: null }]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(avisosAbertos()[0]).toMatchObject({ severity: "critical" });
  });

  it("credencial recusada na 1ª rodada: aviso crítico na hora", async () => {
    const { DETALHE_CREDENCIAL_RECUSADA } = await import("@/lib/channels/health");
    await rodar([semResposta(DETALHE_CREDENCIAL_RECUSADA)]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(avisosAbertos()[0]).toMatchObject({ severity: "critical" });
  });

  it("erro de configuração (sem credencial) avisa na 1ª rodada, sem esperar 3", async () => {
    await rodar([semResposta("sem_credencial_para_a_sessao")]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(avisosAbertos()).toHaveLength(1);
  });

  it("uma rodada sem resposta não troca um QR pendente por 'não foi possível verificar'", async () => {
    await rodar([{ reachable: true, status: "SCAN_QR_CODE", detail: null }, semResposta()]);
    expect(emailsDe("caiu")).toHaveLength(1);
    expect(avisosAbertos()).toHaveLength(1);
    expect(avisosAbertos()[0]).toMatchObject({ kind: "qr_rescan" });
  });
});

describe("o contador de falhas seguidas", () => {
  it("soma a cada rodada sem resposta e zera quando o servidor responde", async () => {
    await rodar([semResposta()]);
    expect(sessao().consecutive_health_fails).toBe(1);
    await rodar([semResposta()]);
    expect(sessao().consecutive_health_fails).toBe(2);
    await rodar([respondeu]);
    expect(sessao().consecutive_health_fails).toBe(0);
  });

  it("depois de zerar, são precisas 3 novas seguidas para avisar", async () => {
    await rodar([semResposta(), semResposta(), respondeu, semResposta(), semResposta()]);
    expect(emails).toHaveLength(0);
    await rodar([semResposta()]);
    expect(emailsDe("caiu")).toHaveLength(1);
  });
});
