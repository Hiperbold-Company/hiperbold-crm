/**
 * Criar > WhatsApp por QR Code: "Servidor" e "Token da instância" são termos de quem instala. Na tela em
 * cartões o formulário só aparece para o administrador da plataforma (`servidorProprio`); para os demais,
 * o caminho é ler o QR Code. Sem o QR disponível na instalação, a tela diz isso em vez de ficar vazia.
 * O onboarding não passa a prop e segue como sempre (formulário à vista).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: { label: "API não oficial", conexoes: [] } })), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/connections/PareamentoQrClient", () => ({ PareamentoQrClient: () => <div>ler-qr</div> }));

import { CanalInstanciaClient } from "@/components/connections/CanalInstanciaClient";

function montar(props: { servidorProprio?: boolean; pareamentoQr?: boolean }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CanalInstanciaClient somenteConectar {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("CanalInstanciaClient: servidor e token só para quem instala", () => {
  it("sem servidorProprio: só o QR, nada de Servidor nem Token", () => {
    montar({ servidorProprio: false, pareamentoQr: true });
    expect(screen.getByText("ler-qr")).toBeInTheDocument();
    expect(screen.queryByLabelText("Servidor")).toBeNull();
    expect(screen.queryByLabelText("Token da instância")).toBeNull();
  });

  it("sem servidorProprio e sem QR na instalação: avisa, sem formulário", () => {
    montar({ servidorProprio: false, pareamentoQr: false });
    expect(screen.getByTestId("qr-indisponivel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Servidor")).toBeNull();
  });

  it("padrão (onboarding) e administrador: o formulário continua", () => {
    montar({});
    expect(screen.getByLabelText("Servidor")).toBeInTheDocument();
    expect(screen.getByLabelText("Token da instância")).toBeInTheDocument();
  });
});
