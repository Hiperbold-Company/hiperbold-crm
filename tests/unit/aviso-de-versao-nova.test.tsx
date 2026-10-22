/**
 * Aviso de versão nova: a aba aberta durante um deploy descobre que o servidor
 * mudou e oferece recarregar. Só com CERTEZA de diferença: igual, erro de rede,
 * 401 ou corpo estranho não acendem nada.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/versao/route";
import {
  AvisoDeVersaoNova,
  INTERVALO_DA_CHECAGEM_MS,
  INTERVALO_MINIMO_NO_FOCO_MS,
} from "@/components/app/AvisoDeVersaoNova";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { checarVersao, compararVersao } from "@/lib/versao/checar";
import { esquecerIdentificadorDaVersao, identificadorDaVersao } from "@/lib/versao/identificador";

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("compararVersao", () => {
  it("mesmo id: mesma", () => {
    expect(compararVersao("abc", { data: { build_id: "abc" } })).toBe("mesma");
  });

  it("id diferente: nova", () => {
    expect(compararVersao("abc", { data: { build_id: "xyz" } })).toBe("nova");
  });

  it.each([
    ["aba sem id", null, { data: { build_id: "xyz" } }],
    ["aba com id vazio", "", { data: { build_id: "xyz" } }],
    ["corpo nulo", "abc", null],
    ["corpo de erro", "abc", { error: { code: "unauthenticated", message: "x" } }],
    ["servidor sem build", "abc", { data: { build_id: null } }],
    ["id vazio", "abc", { data: { build_id: "  " } }],
    ["id não-texto", "abc", { data: { build_id: 42 } }],
    ["corpo HTML como texto", "abc", "<html>"],
  ])("%s: indeterminado", (_nome, carregada, corpo) => {
    expect(compararVersao(carregada, corpo)).toBe("indeterminado");
  });
});

describe("checarVersao", () => {
  it("servidor com outro id: nova", async () => {
    const buscar = vi.fn(async () => resposta(200, { data: { build_id: "novo" } }));
    await expect(checarVersao("velho", buscar as unknown as typeof fetch)).resolves.toBe("nova");
    expect(buscar).toHaveBeenCalledWith("/api/v1/versao", expect.objectContaining({ cache: "no-store" }));
  });

  it("servidor com o mesmo id: mesma", async () => {
    const buscar = vi.fn(async () => resposta(200, { data: { build_id: "velho" } }));
    await expect(checarVersao("velho", buscar as unknown as typeof fetch)).resolves.toBe("mesma");
  });

  it("401 (sessão expirada): indeterminado", async () => {
    const buscar = vi.fn(async () => resposta(401, { error: { code: "unauthenticated" } }));
    await expect(checarVersao("velho", buscar as unknown as typeof fetch)).resolves.toBe("indeterminado");
  });

  it("rede caiu: indeterminado, sem lançar", async () => {
    const buscar = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(checarVersao("velho", buscar as unknown as typeof fetch)).resolves.toBe("indeterminado");
  });

  it("corpo que não é JSON: indeterminado", async () => {
    const buscar = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(checarVersao("velho", buscar as unknown as typeof fetch)).resolves.toBe("indeterminado");
  });

  it("aba sem id: nem pergunta", async () => {
    const buscar = vi.fn();
    await expect(checarVersao(null, buscar as unknown as typeof fetch)).resolves.toBe("indeterminado");
    expect(buscar).not.toHaveBeenCalled();
  });
});

describe("identificador da versão (servidor) e a rota", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "versao-"));
    esquecerIdentificadorDaVersao();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    esquecerIdentificadorDaVersao();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lê o .next/BUILD_ID do processo e a rota o devolve sem cache", async () => {
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "BUILD_ID"), "Xy12AbC\n");
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    expect(identificadorDaVersao()).toBe("Xy12AbC");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    await expect(res.json()).resolves.toEqual({ data: { build_id: "Xy12AbC" } });
  });

  it("sem build (next dev): null, sem lançar", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(identificadorDaVersao()).toBeNull();
    await expect(GET().json()).resolves.toEqual({ data: { build_id: null } });
  });
});

describe("a faixa", () => {
  let buscar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    buscar = vi.fn();
    vi.stubGlobal("fetch", buscar);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function ver(versao: string | null, recarregar = vi.fn()) {
    render(
      <IdiomaProvider locale="pt-BR">
        <AvisoDeVersaoNova versaoCarregada={versao} recarregar={recarregar} />
      </IdiomaProvider>,
    );
    return recarregar;
  }

  async function passar(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("não aparece ao montar, nem pergunta logo de cara", () => {
    ver("velho");
    expect(screen.queryByTestId("aviso-versao-nova")).toBeNull();
    expect(buscar).not.toHaveBeenCalled();
  });

  it("versão diferente no servidor: aparece, acessível, e Atualizar recarrega", async () => {
    buscar.mockImplementation(async () => resposta(200, { data: { build_id: "novo" } }));
    const recarregar = ver("velho");
    await passar(INTERVALO_DA_CHECAGEM_MS);

    const faixa = screen.getByRole("status");
    expect(faixa).toHaveAttribute("aria-live", "polite");
    expect(faixa).toHaveTextContent("Nova versão disponível");
    act(() => screen.getByRole("button", { name: "Atualizar" }).click());
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it("Agora não esconde até a próxima checagem confirmar a diferença", async () => {
    buscar.mockImplementation(async () => resposta(200, { data: { build_id: "novo" } }));
    ver("velho");
    await passar(INTERVALO_DA_CHECAGEM_MS);
    act(() => screen.getByRole("button", { name: "Agora não" }).click());
    expect(screen.queryByTestId("aviso-versao-nova")).toBeNull();

    await passar(INTERVALO_DA_CHECAGEM_MS);
    expect(screen.getByTestId("aviso-versao-nova")).toBeInTheDocument();
  });

  it("mesma versão: nada", async () => {
    buscar.mockImplementation(async () => resposta(200, { data: { build_id: "velho" } }));
    ver("velho");
    await passar(INTERVALO_DA_CHECAGEM_MS);
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("aviso-versao-nova")).toBeNull();
  });

  it("erro de rede ou 401: nada", async () => {
    buscar.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    buscar.mockResolvedValueOnce(resposta(401, { error: { code: "unauthenticated" } }));
    ver("velho");
    await passar(INTERVALO_DA_CHECAGEM_MS * 2);
    expect(buscar).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("aviso-versao-nova")).toBeNull();
  });

  it("aba sem id de versão (next dev): nunca pergunta", async () => {
    ver(null);
    await passar(INTERVALO_DA_CHECAGEM_MS * 3);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("voltar para a aba pergunta, mas não antes do intervalo mínimo", async () => {
    buscar.mockImplementation(async () => resposta(200, { data: { build_id: "novo" } }));
    ver("velho");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(buscar).not.toHaveBeenCalled();

    await passar(INTERVALO_MINIMO_NO_FOCO_MS);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("aviso-versao-nova")).toBeInTheDocument();
  });
});
