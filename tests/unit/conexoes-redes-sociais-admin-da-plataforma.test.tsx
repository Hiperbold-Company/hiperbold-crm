/**
 * Instagram e Messenger seguem ocultos para o cliente (função `conexao-redes-sociais` em
 * `lib/hiperbold/funcoes-ocultas.ts`) até a Meta aprovar o app; o administrador da plataforma os
 * vê para testar com a conta real. O sinal vem do servidor (`redesSociaisLiberadas`), nunca de
 * consulta no cliente.
 *
 * Desde a tela em cartões (17/11/2026) não há mais aba: Instagram e Messenger são tipos do Criar,
 * e o link da volta do OAuth (`?aba=sociais&meta_social=…`) abre o Criar no Instagram.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { funcaoOculta } from "@/lib/hiperbold/funcoes-ocultas";

const h = vi.hoisted(() => ({ busca: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.busca),
  usePathname: () => "/app/connections",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false, support: null } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/channels/useConexoes", () => ({
  useConexoes: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/connections/CanalInstanciaClient", () => ({ CanalInstanciaClient: () => <div>instancia</div> }));
vi.mock("@/components/connections/RedesSociaisClient", () => ({
  RedesSociaisClient: ({ plataformas }: { plataformas?: string[] }) => <div>conteudo-sociais:{plataformas?.join(",")}</div>,
}));
vi.mock("@/components/connections/CanalGraphParceiroClient", () => ({ CanalGraphParceiroClient: () => null }));
vi.mock("@/components/connections/ConectarComAMeta", () => ({ ConectarComAMeta: () => null }));
vi.mock("@/components/connections/CanalParceiroClient", () => ({ CanalParceiroClient: () => null }));
vi.mock("@/components/connections/CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("@/components/connections/TemplatesParceiroClient", () => ({ TemplatesParceiroClient: () => null }));
vi.mock("@/components/connections/TelefoniaClient", () => ({ TelefoniaClient: () => null }));

import { ConexoesShell } from "@/components/connections/ConexoesShell";

function montar(props: { redesSociaisLiberadas?: boolean } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConexoesShell wahaConfigured={false} wacallsConfigured={false} {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.busca = "";
});

describe("Instagram e Messenger no Criar e o administrador da plataforma", () => {
  // Enquanto a função estiver oculta. No dia em que for religada, este caso deixa de valer.
  it.skipIf(!funcaoOculta("conexao-redes-sociais"))("cliente não vê os tipos, nem abrindo ?aba=sociais", () => {
    h.busca = "aba=sociais";
    montar();
    // O `?aba=sociais` sem o tipo liberado cai no primeiro tipo do Criar, nunca nas redes sociais.
    expect(screen.queryByTestId("criar-tipo-instagram")).toBeNull();
    expect(screen.queryByTestId("criar-tipo-messenger")).toBeNull();
    expect(screen.queryByText(/conteudo-sociais/)).toBeNull();
  });

  it("administrador da plataforma vê os tipos e ?aba=sociais abre o Criar no Instagram", () => {
    h.busca = "aba=sociais";
    montar({ redesSociaisLiberadas: true });
    expect(screen.getByTestId("criar-tipo-instagram")).toBeInTheDocument();
    expect(screen.getByTestId("criar-tipo-messenger")).toBeInTheDocument();
    expect(screen.getByText("conteudo-sociais:instagram")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("criar-tipo-messenger"));
    expect(screen.getByText("conteudo-sociais:messenger")).toBeInTheDocument();
  });
});

describe("acesso antecipado às redes sociais", () => {
  it("só a organização da Hiperbold vê antes da liberação", async () => {
    const { acessoAntecipado } = await import("@/lib/hiperbold/funcoes-ocultas");
    expect(acessoAntecipado("conexao-redes-sociais", "d500642e-ccde-46e6-90bd-94868f35c11a")).toBe(true);
    expect(acessoAntecipado("conexao-redes-sociais", "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(acessoAntecipado("conexao-redes-sociais", null)).toBe(false);
    expect(acessoAntecipado("prospeccao", "d500642e-ccde-46e6-90bd-94868f35c11a")).toBe(false);
  });
});
