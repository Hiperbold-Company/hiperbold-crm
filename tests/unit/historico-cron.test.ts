import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClienteWaha from "@/lib/waha/client";

/**
 * O cron da importação do histórico (#999): uma rodada por importação
 * `rodando` a cada chamada, com o teto padrão, e nunca duas execuções da mesma
 * importação ao mesmo tempo (a rodada diz que serializar é de quem dispara).
 * A trava é `cursor.trava_ate`, gravada por update condicional no
 * `updated_at` lido; a rodada a apaga ao gravar o cursor dela.
 */
type Linha = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tabela: [] as Linha[],
  updates: [] as Array<{ payload: Linha; filtros: Record<string, unknown> }>,
  selects: [] as Array<Record<string, unknown>>,
  rodadas: [] as Array<{ id: string; teto: unknown; opcoes?: { prazo?: number } }>,
  autoriza: true,
  rodadaLanca: null as string | null,
  aposSelect: null as null | (() => void),
  /** Quanto o relógio anda a cada rodada dublada (ms). */
  avancoPorRodada: 0,
  /** Status que a rodada dublada devolve, por id de importação (padrão: rodando). */
  statusDaRodada: {} as Record<string, string>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => h.autoriza }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const auditEspiao = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditEspiao }));
vi.mock("@/lib/channels/historico/rodada", () => ({
  TETO_PADRAO: { conversas: 3, mensagens: 300, chamadas: 20 },
  rodarUmaRodada: vi.fn(async (_admin: unknown, id: string, teto: unknown, opcoes?: { prazo?: number }) => {
    h.rodadas.push({ id, teto, opcoes });
    if (h.avancoPorRodada) vi.setSystemTime(Date.now() + h.avancoPorRodada);
    if (h.rodadaLanca) throw new Error(h.rodadaLanca);
    return { status: h.statusDaRodada[id] ?? "rodando", gravadas: 1, existentes: 0 };
  }),
}));
// Os passos da queda (Spec 32) têm o próprio teste: aqui só importa que o cron os chame
// e que a falha de um deles não tire as rodadas.
const quedasEspiao = vi.hoisted(() => ({
  abrir: vi.fn(async (_admin: unknown, _agora: Date, _organizacoes?: string[]) => ({ criadas: 0 })),
  preparar: vi.fn(async (_admin: unknown, _agora: Date, _organizacoes?: string[]) => ({ promovidas: 0, canceladas: 0 })),
  operantes: vi.fn(async () => [] as string[]),
}));
vi.mock("@/lib/channels/historico/quedas", () => ({
  abrirRecuperacoesDasQuedas: quedasEspiao.abrir,
  prepararRecuperacoesAguardando: quedasEspiao.preparar,
  organizacoesOperantes: quedasEspiao.operantes,
}));
const fecharEspiao = vi.hoisted(() => vi.fn(async (_admin: unknown, _org: string) => 0));
vi.mock("@/lib/channels/historico/avisos-da-queda", () => ({ fecharAvisosDeClienteRespondido: fecharEspiao }));
// O pool `pg` do piso ocioso: o retrato diz "histórico ligado" e a lista de
// organizações vem de `pgFalso.orgs` (`null` = a consulta falha e a rota olha todas).
const pgFalso = vi.hoisted(() => ({ orgs: null as string[] | null, consultas: [] as string[] }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({
    query: async (sql: string) => {
      pgFalso.consultas.push(sql);
      if (sql.includes("as organization_id")) {
        if (pgFalso.orgs === null) throw new Error("banco fora");
        return { rows: pgFalso.orgs.map((organization_id) => ({ organization_id })) };
      }
      return { rows: [{ historico: true }] };
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      if (t !== "importacoes_de_historico") throw new Error(`tabela inesperada: ${t}`);
      const consulta = (op: "select" | "update", payload?: Linha) => {
        const filtros: Record<string, unknown> = {};
        const rodar = async () => {
          const alvo = h.tabela.filter((l) =>
            Object.entries(filtros).every(([k, v]) => (k === "organizations.status" ? true : l[k] === v)),
          );
          if (op === "update") {
            h.updates.push({ payload: payload!, filtros: { ...filtros } });
            alvo.forEach((l) => Object.assign(l, payload));
            return { data: alvo.map((l) => ({ id: l.id })), error: null };
          }
          h.selects.push({ ...filtros });
          const copia = alvo.map((l) => ({ ...l }));
          h.aposSelect?.();
          return { data: copia, error: null };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (k: string, v: unknown) => { filtros[k] = v; return q; },
          order: () => q,
          limit: () => q,
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => rodar().then(res, rej),
        };
        return q;
      };
      return { select: () => consulta("select"), update: (p: Linha) => consulta("update", p) };
    },
  }),
}));

const { GET } = await import("@/app/api/v1/cron/historico-import/route");
const { MARGEM_PARA_CHAMADA_MS, PRAZO_DA_CHAMADA_MS } = await import("@/lib/channels/historico/prazo");
const chamar = () => GET(new Request("http://localhost/api/v1/cron/historico-import") as never);
const linha = (id: string, extra: Linha = {}): Linha => ({
  id,
  organization_id: "org",
  channel_session_id: `s-${id}`,
  status: "rodando",
  cursor: { indiceConversa: 2, offsetMensagens: 0, desde: 1 },
  updated_at: "2026-10-20T10:00:00.000Z",
  organizations: { status: "active" },
  ...extra,
});

beforeEach(() => {
  h.tabela = [];
  h.updates.length = 0;
  h.selects.length = 0;
  h.rodadas.length = 0;
  h.autoriza = true;
  h.rodadaLanca = null;
  h.aposSelect = null;
  h.avancoPorRodada = 0;
  h.statusDaRodada = {};
  auditEspiao.mockReset();
  quedasEspiao.abrir.mockClear();
  quedasEspiao.preparar.mockClear();
  quedasEspiao.operantes.mockReset();
  quedasEspiao.operantes.mockResolvedValue([]);
  fecharEspiao.mockClear();
  pgFalso.orgs = null;
  pgFalso.consultas.length = 0;
  vi.useRealTimers();
});

describe("cron da importação do histórico: só as organizações com o que olhar", () => {
  it("a lista vem de UMA consulta pelo pool e nenhum passo da queda vai listar as operantes pelo PostgREST", async () => {
    pgFalso.orgs = ["org-a", "org-b"];
    await chamar();
    expect(quedasEspiao.operantes).not.toHaveBeenCalled();
    expect(quedasEspiao.abrir).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ["org-a", "org-b"]);
    expect(quedasEspiao.preparar).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ["org-a", "org-b"]);
    expect(fecharEspiao.mock.calls.map((c) => c[1])).toEqual(["org-a", "org-b"]);
    expect(pgFalso.consultas.filter((q) => q.includes("as organization_id"))).toHaveLength(1);
  });

  it("nenhuma organização com o que olhar: os passos da queda rodam sobre lista vazia, sem fechar aviso", async () => {
    pgFalso.orgs = [];
    await chamar();
    expect(quedasEspiao.operantes).not.toHaveBeenCalled();
    expect(quedasEspiao.abrir).toHaveBeenCalledWith(expect.anything(), expect.any(Date), []);
    expect(fecharEspiao).not.toHaveBeenCalled();
  });

  it("a consulta do pool falha: volta a olhar TODAS as operantes (na dúvida, roda)", async () => {
    pgFalso.orgs = null;
    quedasEspiao.operantes.mockResolvedValue(["org-x", "org-y", "org-z"]);
    await chamar();
    expect(quedasEspiao.operantes).toHaveBeenCalledTimes(1);
    expect(quedasEspiao.abrir).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ["org-x", "org-y", "org-z"]);
    expect(quedasEspiao.preparar).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ["org-x", "org-y", "org-z"]);
    expect(fecharEspiao.mock.calls.map((c) => c[1])).toEqual(["org-x", "org-y", "org-z"]);
  });

  it("a listagem das operantes também falha: as rodadas das importações seguem", async () => {
    pgFalso.orgs = null;
    quedasEspiao.operantes.mockRejectedValue(new Error("organizations fora do ar"));
    h.tabela = [linha("a")];
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(h.rodadas.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("cron da importação do histórico (#999)", () => {
  it("um passo da queda que falha não para as rodadas", async () => {
    quedasEspiao.abrir.mockRejectedValueOnce(new Error("event_log fora do ar"));
    h.tabela = [linha("a")];
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(quedasEspiao.abrir).toHaveBeenCalledTimes(1);
    expect(h.rodadas.map((x) => x.id)).toEqual(["a"]);
  });

  it("sem segredo é 403 e não varre nada", async () => {
    h.autoriza = false;
    expect((await chamar()).status).toBe(403);
    expect(h.selects).toEqual([]);
    expect(h.rodadas).toEqual([]);
  });

  it("roda UMA rodada de cada importação rodando, com o teto padrão", async () => {
    h.tabela = [linha("a"), linha("b"), linha("c", { status: "previa" }), linha("d", { status: "concluida" })];
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(h.rodadas.map((x) => x.id)).toEqual(["a", "b"]);
    expect(h.rodadas[0]!.teto).toEqual({ conversas: 3, mensagens: 300, chamadas: 20 });
    expect(h.selects[0]).toMatchObject({ status: "rodando" });
    expect((await r.json()).data).toMatchObject({ rodadas: 2 });
  });

  it("a rodada recebe o prazo da chamada, e o curl do agendador espera mais que ele, com folga", async () => {
    h.tabela = [linha("a")];
    const inicio = Date.now();
    await chamar();
    const prazo = h.rodadas[0]!.opcoes?.prazo;
    expect(typeof prazo).toBe("number");
    expect(prazo!).toBeGreaterThan(inicio);
    expect(prazo!).toBeLessThanOrEqual(Date.now() + PRAZO_DA_CHAMADA_MS);

    const entrypoint = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
    const job = entrypoint.match(/^[^#\n]*\|(\d+)\|api\/v1\/cron\/historico-import$/m);
    expect(job).not.toBeNull();
    // folga para as gravações no banco depois da última chamada ao canal
    expect(Number(job![1]) * 1000).toBeGreaterThanOrEqual(PRAZO_DA_CHAMADA_MS + 15_000);
  });

  it("sem tempo para uma chamada ao canal, não começa outra rodada nem trava a importação", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    h.tabela = [linha("a"), linha("b")];
    // a primeira rodada deixa menos de uma chamada de tempo pela frente
    h.avancoPorRodada = PRAZO_DA_CHAMADA_MS - MARGEM_PARA_CHAMADA_MS + 1;
    await chamar();
    expect(h.rodadas.map((x) => x.id)).toEqual(["a"]);
    expect(h.updates.map((u) => u.filtros.id)).toEqual(["a"]);
  });

  it("a margem para uma chamada é o teto padrão do cliente do WAHA, e cabe o download", async () => {
    const { TETO_PADRAO_MS } = await vi.importActual<typeof ClienteWaha>("@/lib/waha/client");
    const { TETO_DO_DOWNLOAD_MS } = await import("@/lib/channels/historico/prazo");
    expect(MARGEM_PARA_CHAMADA_MS).toBe(TETO_PADRAO_MS);
    expect(TETO_DO_DOWNLOAD_MS).toBeLessThanOrEqual(MARGEM_PARA_CHAMADA_MS);
  });

  it("trava antes de rodar: update condicional no updated_at lido, com trava_ate no cursor", async () => {
    h.tabela = [linha("a")];
    await chamar();
    const trava = h.updates[0]!;
    expect(trava.filtros).toMatchObject({ id: "a", organization_id: "org", status: "rodando", updated_at: "2026-10-20T10:00:00.000Z" });
    expect(trava.payload.cursor).toMatchObject({ indiceConversa: 2, offsetMensagens: 0, desde: 1 });
    expect(Date.parse((trava.payload.cursor as { trava_ate: string }).trava_ate)).toBeGreaterThan(Date.now());
  });

  it("importação com trava vigente fica de fora; trava vencida é retomada", async () => {
    const futuro = new Date(Date.now() + 60_000).toISOString();
    const passado = new Date(Date.now() - 60_000).toISOString();
    h.tabela = [
      linha("presa", { cursor: { indiceConversa: 0, offsetMensagens: 0, trava_ate: futuro } }),
      linha("vencida", { cursor: { indiceConversa: 0, offsetMensagens: 0, trava_ate: passado } }),
    ];
    await chamar();
    expect(h.rodadas.map((x) => x.id)).toEqual(["vencida"]);
  });

  it("quem perde a trava (outra execução gravou antes) não roda", async () => {
    h.tabela = [linha("a")];
    // Outra execução travou a linha entre a leitura e a trava: o updated_at não bate.
    h.aposSelect = () => {
      h.tabela[0]!.updated_at = "2026-10-20T10:00:05.000Z";
    };
    await chamar();
    expect(h.rodadas).toEqual([]);
  });

  it("o FIM da importação audita (concluída ou erro); rodada que só anda o cursor não", async () => {
    h.tabela = [linha("a"), linha("b"), linha("c")];
    h.statusDaRodada = { a: "concluida", b: "erro" };
    await chamar();
    expect(auditEspiao.mock.calls.map(([e]) => [e.action, e.resourceId, e.metadata?.importacao_id])).toEqual([
      ["channel.historico_import_completed", "s-a", "a"],
      ["channel.historico_import_failed", "s-b", "b"],
    ]);
    expect(auditEspiao.mock.calls.every(([e]) => e.organizationId === "org")).toBe(true);
  });

  it("rodada que lança não derruba o lote", async () => {
    h.tabela = [linha("a"), linha("b")];
    h.rodadaLanca = "importacao_leitura: caiu";
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(h.rodadas.map((x) => x.id)).toEqual(["a", "b"]);
    expect((await r.json()).data).toMatchObject({ falhas: 2 });
  });
});
