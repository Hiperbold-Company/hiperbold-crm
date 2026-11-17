/**
 * Desligar e religar um módulo de tabela (migration 1016), do serviço até a leitura que as telas,
 * rotas, a navegação e as tools MCP fazem (`moduloLigado`).
 *
 * O dublê é do BANCO, não do nosso código: guarda `modulos_instalados` e as tabelas do módulo em
 * memória, reproduz o contrato de `fn_modulo_definir_estado` (ator, recibo idempotente, estado
 * visto) e registra toda tentativa de DELETE ou DROP. O serviço e `moduloLigado` são os reais.
 * O corpo SQL de verdade é provado em `tests/invariants/modulo-desligado-preserva-dados.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Estado = "ativo" | "suspenso" | "desligado";
type Erro = { code: string; message: string };

const ADMIN = randomUUID();
const INTRUSO = randomUUID();

function bancoFalso() {
  const modulos = new Map<string, { estado: Estado; motivo?: string | null }>();
  const comandas = [{ id: "c1" }, { id: "c2" }];
  const recibos = new Map<string, { fingerprint: string; recibo: Record<string, unknown> }>();
  const destrutivos: string[] = [];
  const sqlExecutado: string[] = [];

  function consulta(tabela: string) {
    const filtros: Array<(linha: Record<string, unknown>) => boolean> = [];
    const linhas = (): Array<Record<string, unknown>> =>
      tabela === "modulos_instalados"
        ? [...modulos.entries()].map(([modulo, v]) => ({ modulo, estado: v.estado }))
        : tabela === "comandas"
          ? comandas
          : [];
    const resolver = () => ({ data: linhas().filter((l) => filtros.every((f) => f(l))), error: null });
    const builder = {
      select: () => builder,
      in: (coluna: string, valores: readonly unknown[]) => {
        filtros.push((l) => valores.includes(l[coluna]));
        return builder;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] === valor);
        return builder;
      },
      order: () => Promise.resolve(resolver()),
      delete: () => {
        destrutivos.push(`delete ${tabela}`);
        return builder;
      },
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, falha),
    };
    return builder;
  }

  function definirEstado(args: Record<string, unknown>): { data: unknown; error: Erro | null } {
    const p0001 = (message: string) => ({ data: null, error: { code: "P0001", message } });
    if (args.p_actor !== ADMIN) return p0001("extension_forbidden");
    const fingerprint = JSON.stringify([args.p_modulo, args.p_ligar, args.p_estado_visto]);
    const op = String(args.p_operation);
    const anterior = recibos.get(op);
    if (anterior) {
      if (anterior.fingerprint !== fingerprint) return p0001("extension_idempotency_conflict");
      return { data: { ...anterior.recibo, applied_now: false }, error: null };
    }
    const linha = modulos.get(String(args.p_modulo));
    if (!linha) return p0001("extension_module_not_installed");
    const ligar = args.p_ligar === true;
    if (
      linha.estado !== args.p_estado_visto ||
      (ligar && linha.estado !== "desligado") ||
      (!ligar && linha.estado !== "ativo")
    ) {
      return p0001("extension_module_state_changed");
    }
    if (ligar && linha.motivo) {
      return { data: null, error: { code: "PT428", message: "extension_module_needs_update" } };
    }
    linha.estado = ligar ? "ativo" : "desligado";
    const agora = new Date().toISOString();
    const recibo = {
      id: op,
      kind: ligar ? "module_enable" : "module_disable",
      status: "completed",
      actor_id: ADMIN,
      name: args.p_modulo,
      result: { modulo: args.p_modulo },
      created_at: agora,
      updated_at: agora,
    };
    recibos.set(op, { fingerprint, recibo });
    return { data: { ...recibo, applied_now: true }, error: null };
  }

  const db = {
    from: (tabela: string) => consulta(tabela),
    rpc: (nome: string, args: Record<string, unknown>) => {
      sqlExecutado.push(nome);
      if (/drop|delete|truncate/i.test(nome)) destrutivos.push(nome);
      if (nome !== "fn_modulo_definir_estado") throw new Error(`rpc inesperada: ${nome}`);
      return Promise.resolve(definirEstado(args));
    },
  };
  return { db, modulos, comandas, destrutivos, sqlExecutado };
}

const mocks = vi.hoisted(() => ({ banco: null as unknown, audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (mocks.banco as ReturnType<typeof bancoFalso>).db,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";

import { definirEstadoDoModulo } from "./service";

let banco: ReturnType<typeof bancoFalso>;
const ligado = () => moduloLigado(createAdminClient(), "financeiro");

beforeEach(() => {
  banco = bancoFalso();
  banco.modulos.set("financeiro", { estado: "ativo" });
  mocks.banco = banco;
  mocks.audit.mockClear();
});

describe("desligar e religar Comandas", () => {
  it("desligar troca o estado e moduloLigado passa a false; religar volta a true", async () => {
    expect(await ligado()).toBe(true);

    const desligou = await definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", false, "ativo");
    expect(desligou.appliedNow).toBe(true);
    expect(banco.modulos.get("financeiro")?.estado).toBe("desligado");
    expect(await ligado()).toBe(false);

    const religou = await definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", true, "desligado");
    expect(religou.appliedNow).toBe(true);
    expect(await ligado()).toBe(true);

    expect(mocks.audit.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      "modulo.desligado",
      "modulo.religado",
    ]);
  });

  it("não apaga dado nenhum: só uma RPC de estado, nenhum DELETE nem DROP, as linhas do módulo ficam", async () => {
    await definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", false, "ativo");
    await definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", true, "desligado");

    expect(banco.destrutivos).toEqual([]);
    expect(banco.sqlExecutado).toEqual(["fn_modulo_definir_estado", "fn_modulo_definir_estado"]);
    expect(banco.comandas).toHaveLength(2);
    expect(banco.modulos.has("financeiro")).toBe(true);
  });

  it("repetir a mesma chave devolve o mesmo recibo, sem trocar de novo nem auditar de novo", async () => {
    const chave = randomUUID();
    await definirEstadoDoModulo(ADMIN, chave, "financeiro", false, "ativo");
    const repetido = await definirEstadoDoModulo(ADMIN, chave, "financeiro", false, "ativo");

    expect(repetido).toEqual({ operationId: chave, appliedNow: false });
    expect(banco.modulos.get("financeiro")?.estado).toBe("desligado");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("estado que a tela viu está velho = 409, nada muda", async () => {
    banco.modulos.set("financeiro", { estado: "desligado" });

    await expect(
      definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", false, "ativo"),
    ).rejects.toMatchObject({ code: "extension_module_state_changed", status: 409 });
    expect(banco.modulos.get("financeiro")?.estado).toBe("desligado");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("quem não é administrador da instalação é recusado pelo banco, sem efeito", async () => {
    await expect(
      definirEstadoDoModulo(INTRUSO, randomUUID(), "financeiro", false, "ativo"),
    ).rejects.toMatchObject({ code: "extension_forbidden", status: 403 });
    expect(await ligado()).toBe(true);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("módulo não instalado = 404; módulo fora do catálogo nem chega ao banco", async () => {
    await expect(
      definirEstadoDoModulo(ADMIN, randomUUID(), "honorarios", false, "ativo"),
    ).rejects.toMatchObject({ code: "extension_module_not_installed", status: 404 });
    await expect(
      definirEstadoDoModulo(ADMIN, randomUUID(), "nao_existe", false, "ativo"),
    ).rejects.toMatchObject({ code: "extension_module_unknown" });
    expect(banco.sqlExecutado).toEqual(["fn_modulo_definir_estado"]);
  });

  it("religar um módulo cuja última atualização falhou = 409 com a mensagem legível, nada muda", async () => {
    banco.modulos.set("financeiro", { estado: "desligado", motivo: "a provisionadora falhou" });

    await expect(
      definirEstadoDoModulo(ADMIN, randomUUID(), "financeiro", true, "desligado"),
    ).rejects.toMatchObject({
      code: "extension_module_needs_update",
      status: 409,
      message: "O módulo teve falha na última atualização; rode a atualização antes de religar.",
    });
    expect(banco.modulos.get("financeiro")?.estado).toBe("desligado");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
