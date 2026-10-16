import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email/conta-e-cobranca/recibo-de-exclusao", () => ({ enviarReciboDeExclusao: vi.fn(async () => 1) }));
vi.mock("@/lib/retencao/exclusao-de-organizacao/conexoes", () => ({
  encerrarConexoesDaOrganizacao: vi.fn(async () => ({ encerradas: 2, falhas: 0 })),
}));
const apagarArquivos = vi.fn();
vi.mock("@/lib/retencao/exclusao-de-organizacao/armazenamento", () => ({
  apagarArquivosDaOrganizacao: (...a: unknown[]) => apagarArquivos(...a),
}));

import { criarEnfileiradorDeAvisoDeExclusao } from "@/lib/email/conta-e-cobranca/gatilhos-de-exclusao";
import { enfileirarAvisosDevidos, excluirOrganizacao, rodarExclusaoDeDados } from "@/lib/retencao/exclusao-de-organizacao/rodada";

const ORG = "11111111-2222-4333-8444-555555555555";

/** Um admin falso que registra o que a rodada pede ao banco. */
function adminFalso(opcoes: {
  programacoes?: unknown[];
  vencidas?: unknown[];
  rpc?: (nome: string, args: unknown) => { data?: unknown; error?: unknown };
}) {
  const atualizacoes: { tabela: string; valores: Record<string, unknown>; org: unknown }[] = [];
  const rpcs: { nome: string; args: unknown }[] = [];
  const admin = {
    from(tabela: string) {
      const estado: { filtros: Record<string, unknown>; modo: string } = { filtros: {}, modo: "select" };
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => {
          estado.filtros[c] = v;
          return cadeia;
        },
        gt: () => ((estado.modo = "avisos"), cadeia),
        lte: () => ((estado.modo = "vencidas"), cadeia),
        order: () => cadeia,
        maybeSingle: async () => ({ data: { display_name: "Empresa Teste" }, error: null }),
        limit: async () => ({
          data: estado.modo === "vencidas" ? (opcoes.vencidas ?? []) : (opcoes.programacoes ?? []),
          error: null,
        }),
        update: (valores: Record<string, unknown>) => ({
          eq: async (_c: string, org: unknown) => {
            atualizacoes.push({ tabela, valores, org });
            return { error: null };
          },
        }),
      };
      return cadeia;
    },
    rpc: async (nome: string, args: unknown) => {
      rpcs.push({ nome, args });
      // A guarda de leitura diz ok por padrão; cada caso troca o que quer provar.
      const padrao = nome === "fn_exclusao_pode_executar" ? { data: "ok", error: null } : { data: null, error: null };
      return (opcoes.rpc?.(nome, args) ?? padrao) as { data: unknown; error: unknown };
    },
  };
  return { admin: admin as never, atualizacoes, rpcs };
}

const prog = (extra: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  origem: "automatica",
  motivo: "cancelada",
  excluir_em: "2026-12-31T08:00:00Z",
  aviso_30_dias_em: null,
  aviso_7_dias_em: null,
  ...extra,
});

describe("avisos D-30 e D-7", () => {
  it("enfileira o D-30 com chave por data e cópia ao operador, e marca o aviso", async () => {
    const { admin, atualizacoes } = adminFalso({ programacoes: [prog()] });
    const enfileirar = vi.fn(async (_a?: unknown) => "enfileirado" as const);
    const n = await enfileirarAvisosDevidos(admin, new Date("2026-12-05T12:00:00Z"), async (a) => enfileirar(a));
    expect(n).toBe(1);
    expect(enfileirar).toHaveBeenCalledWith({
      organizationId: ORG,
      chave: "exclusao:2026-12-31:d30",
      excluirEm: "2026-12-31",
      dias: 30,
      motivo: "cancelada",
    });
    expect(atualizacoes[0]?.valores).toHaveProperty("aviso_30_dias_em");
  });

  it("segunda rodada no mesmo dia (marcador gravado) não enfileira nada", async () => {
    const { admin, atualizacoes } = adminFalso({ programacoes: [prog({ aviso_30_dias_em: "2026-12-05T06:00:00Z" })] });
    const enfileirar = vi.fn(async (_a?: unknown) => "enfileirado" as const);
    expect(await enfileirarAvisosDevidos(admin, new Date("2026-12-05T18:00:00Z"), async (a) => enfileirar(a))).toBe(0);
    expect(enfileirar).not.toHaveBeenCalled();
    expect(atualizacoes).toHaveLength(0);
  });

  it("fila que já tinha o aviso (ja_existia) não conta como novo, mas o marcador é gravado", async () => {
    const { admin, atualizacoes } = adminFalso({ programacoes: [prog()] });
    const n = await enfileirarAvisosDevidos(admin, new Date("2026-12-26T12:00:00Z"), async () => "ja_existia");
    expect(n).toBe(0);
    expect(atualizacoes[0]?.valores).toHaveProperty("aviso_7_dias_em");
  });

  it("falha ao enfileirar não grava o marcador (tenta de novo amanhã)", async () => {
    const { admin, atualizacoes } = adminFalso({ programacoes: [prog()] });
    await enfileirarAvisosDevidos(admin, new Date("2026-12-26T12:00:00Z"), async () => "falhou");
    expect(atualizacoes).toHaveLength(0);
  });

  it("o gatilho enfileira COB-12 para os admins com cópia ao operador", async () => {
    const enfileirar = vi.fn(async (_a?: unknown) => "enfileirado" as const);
    await criarEnfileiradorDeAvisoDeExclusao({} as never, enfileirar)({
      organizationId: ORG,
      chave: "exclusao:2026-12-31:d7",
      excluirEm: "2026-12-31",
      dias: 7,
      motivo: "suspensa",
    });
    expect(enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: "COB-12", destino: "admins", copiaParaOperador: true, organizationId: ORG }),
    );
  });
});

describe("excluir uma organização", () => {
  it("A GUARDA VEM ANTES DO STORAGE: recusada pelo banco, nada é apagado no Storage nem nas conexões", async () => {
    apagarArquivos.mockReset();
    for (const recusa of ["exclusao_org_reativada", "exclusao_sem_aviso_de_7_dias", "exclusao_ainda_nao_venceu", "exclusao_cancelada", "exclusao_nao_programada"]) {
      const { admin, rpcs } = adminFalso({ rpc: (nome) => (nome === "fn_exclusao_pode_executar" ? { data: recusa } : { data: null }) });
      expect(await excluirOrganizacao(admin, ORG, null)).toEqual({ ok: false, etapa: "guarda", motivo: recusa });
      expect(rpcs.map((x) => x.nome)).toEqual(["fn_exclusao_pode_executar"]);
    }
    expect(apagarArquivos).not.toHaveBeenCalled();
  });

  it("guarda indisponível (erro do banco) também não toca em nada", async () => {
    apagarArquivos.mockReset();
    const { admin } = adminFalso({ rpc: () => ({ error: { code: "XX000" } }) });
    expect(await excluirOrganizacao(admin, ORG, null)).toMatchObject({ ok: false, etapa: "banco" });
    expect(apagarArquivos).not.toHaveBeenCalled();
  });

  it("a exclusão forçada do admin pergunta e executa com p_forcar", async () => {
    apagarArquivos.mockResolvedValue({ ok: true, apagados: 0 });
    const { admin, rpcs } = adminFalso({ rpc: (nome) => ({ data: nome === "fn_exclusao_pode_executar" ? "ok" : { origem: "manual", motivo: "manual" } }) });
    await excluirOrganizacao(admin, ORG, "admin-1", { forcar: true });
    expect(rpcs.map((x) => [x.nome, (x.args as { p_forcar?: boolean }).p_forcar])).toEqual([
      ["fn_exclusao_pode_executar", true],
      ["fn_exclusao_executar", true],
    ]);
    expect(rpcs.some((x) => x.nome === "fn_exclusao_programar")).toBe(false);
  });

  it("falha no Storage: o banco NÃO é chamado (a organização fica para a próxima rodada)", async () => {
    apagarArquivos.mockResolvedValue({ ok: false, apagados: 3, motivo: "storage_remover:whatsapp-media" });
    const { admin, rpcs } = adminFalso({});
    const r = await excluirOrganizacao(admin, ORG, null);
    expect(r).toEqual({ ok: false, etapa: "armazenamento", motivo: "storage_remover:whatsapp-media" });
    expect(rpcs.find((x) => x.nome === "fn_exclusao_executar")).toBeUndefined();
  });

  it("a guarda do banco recusa (reativou): vira etapa guarda, sem lançar", async () => {
    apagarArquivos.mockResolvedValue({ ok: true, apagados: 0 });
    const { admin } = adminFalso({ rpc: (nome) => (nome === "fn_exclusao_pode_executar" ? { data: "ok" } : { error: { message: "exclusao_org_reativada", code: "22023" } }) });
    expect(await excluirOrganizacao(admin, ORG, null)).toEqual({ ok: false, etapa: "guarda", motivo: "exclusao_org_reativada" });
  });

  it("sucesso: chama fn_exclusao_executar com a organização e o ator e devolve o resumo", async () => {
    apagarArquivos.mockResolvedValue({ ok: true, apagados: 7 });
    const { admin, rpcs } = adminFalso({
      rpc: (nome) => ({ data: nome === "fn_exclusao_pode_executar" ? "ok" : { organization_id: ORG, origem: "automatica", motivo: "suspensa", contatos: 4, usuarios_removidos: 1 } }),
    });
    const r = await excluirOrganizacao(admin, ORG, "ator-1");
    expect(rpcs.find((x) => x.nome === "fn_exclusao_executar")).toEqual({
      nome: "fn_exclusao_executar",
      args: { p_org: ORG, p_actor: "ator-1", p_forcar: false },
    });
    expect(r.ok && r.resumo).toMatchObject({ contatos: 4, arquivos_apagados: 7, conexoes_encerradas: 2 });
  });
});

describe("a rodada", () => {
  it("sincronização falhou: NADA é avisado nem excluído nessa rodada, mesmo com vencidas na tabela", async () => {
    apagarArquivos.mockReset();
    const { admin, rpcs } = adminFalso({
      programacoes: [prog()],
      vencidas: [prog()],
      rpc: (nome) => (nome === "fn_exclusao_sincronizar" ? { error: { code: "XX000" } } : { data: 0 }),
    });
    const r = await rodarExclusaoDeDados(admin, { diasDeGuarda: 90, agora: new Date("2027-01-02T09:00:00Z") });
    expect(r).toMatchObject({ sincronizacaoFalhou: true, avisosEnfileirados: 0, vencidas: 0, excluidas: 0 });
    expect(rpcs.some((x) => x.nome === "fn_exclusao_executar" || x.nome === "fn_exclusao_pode_executar")).toBe(false);
    expect(apagarArquivos).not.toHaveBeenCalled();
  });

  it("rodada vazia: tudo zero, só sincroniza e expurga", async () => {
    const { admin, rpcs } = adminFalso({
      rpc: (nome) => ({ data: nome === "fn_exclusao_sincronizar" ? { programadas: 0, atualizadas: 0, canceladas_por_reativacao: 0 } : 0 }),
    });
    const r = await rodarExclusaoDeDados(admin, { diasDeGuarda: 90, agora: new Date("2026-10-16T09:00:00Z") });
    expect(r).toMatchObject({ programadas: 0, avisosEnfileirados: 0, vencidas: 0, excluidas: 0, falhas: 0 });
    expect(rpcs.map((x) => x.nome)).toEqual(["fn_exclusao_sincronizar", "fn_exclusao_expurgar_fiscais_vencidos"]);
    expect(rpcs[0]?.args).toEqual({ p_dias: 90 });
  });

  it("exclui as vencidas uma a uma e conta falha sem interromper as demais", async () => {
    const OUTRA = "99999999-2222-4333-8444-555555555555";
    apagarArquivos.mockResolvedValueOnce({ ok: false, apagados: 0, motivo: "x" }).mockResolvedValue({ ok: true, apagados: 0 });
    const { admin } = adminFalso({
      vencidas: [prog(), prog({ organization_id: OUTRA })],
      rpc: (nome) => ({ data: nome === "fn_exclusao_pode_executar" ? "ok" : nome === "fn_exclusao_executar" ? { origem: "automatica", motivo: "cancelada" } : { programadas: 0 } }),
    });
    const r = await rodarExclusaoDeDados(admin, { diasDeGuarda: 90, agora: new Date("2027-01-02T09:00:00Z") });
    expect(r).toMatchObject({ vencidas: 2, excluidas: 1, falhas: 1 });
  });
});
