/**
 * A aba "Redes sociais" segue oculta para o cliente (função `conexao-redes-sociais`
 * em `lib/hiperbold/funcoes-ocultas.ts`) até a Meta aprovar o app; o administrador
 * da plataforma a vê para testar com a conta real. O sinal vem do servidor
 * (`redesSociaisLiberadas`), nunca de consulta no cliente.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { funcaoOculta } from "@/lib/hiperbold/funcoes-ocultas";

const h = vi.hoisted(() => ({ busca: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.busca),
  usePathname: () => "/app/connections",
}));
vi.mock("@/components/connections/CanalInstanciaClient", () => ({ CanalInstanciaClient: () => <div>instancia</div> }));
vi.mock("@/components/connections/RedesSociaisClient", () => ({ RedesSociaisClient: () => <div>conteudo-sociais</div> }));
vi.mock("@/components/connections/CanalGraphParceiroClient", () => ({ CanalGraphParceiroClient: () => null }));
vi.mock("@/components/connections/CanalOficialClient", () => ({ CanalOficialClient: () => null }));
vi.mock("@/components/connections/CanalParceiroClient", () => ({ CanalParceiroClient: () => null }));
vi.mock("@/components/connections/CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("@/components/connections/TemplatesClient", () => ({ TemplatesClient: () => null }));
vi.mock("@/components/connections/TemplatesParceiroClient", () => ({ TemplatesParceiroClient: () => null }));
vi.mock("@/components/connections/TelefoniaClient", () => ({ TelefoniaClient: () => null }));

import { ConexoesShell } from "@/components/connections/ConexoesShell";

afterEach(() => {
  cleanup();
  h.busca = "";
});

describe("aba Redes sociais e o administrador da plataforma", () => {
  // Enquanto a função estiver oculta. No dia em que for religada, este caso deixa de valer.
  it.skipIf(!funcaoOculta("conexao-redes-sociais"))("cliente não vê a aba, nem abrindo ?aba=sociais", () => {
    h.busca = "aba=sociais";
    render(<ConexoesShell wahaConfigured={false} wacallsConfigured={false} />);
    expect(screen.queryByRole("tab", { name: "Redes sociais" })).toBeNull();
    expect(screen.queryByText("conteudo-sociais")).toBeNull();
  });

  it("administrador da plataforma vê a aba e abre o conteúdo por ?aba=sociais", () => {
    h.busca = "aba=sociais";
    render(<ConexoesShell wahaConfigured={false} wacallsConfigured={false} redesSociaisLiberadas />);
    expect(screen.getByRole("tab", { name: "Redes sociais" })).toBeInTheDocument();
    expect(screen.getByText("conteudo-sociais")).toBeInTheDocument();
  });
});

describe("acesso antecipado à aba Redes sociais", () => {
  it("só a organização da Hiperbold vê antes da liberação", async () => {
    const { acessoAntecipado } = await import("@/lib/hiperbold/funcoes-ocultas");
    expect(acessoAntecipado("conexao-redes-sociais", "d500642e-ccde-46e6-90bd-94868f35c11a")).toBe(true);
    expect(acessoAntecipado("conexao-redes-sociais", "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(acessoAntecipado("conexao-redes-sociais", null)).toBe(false);
    expect(acessoAntecipado("prospeccao", "d500642e-ccde-46e6-90bd-94868f35c11a")).toBe(false);
  });
});
