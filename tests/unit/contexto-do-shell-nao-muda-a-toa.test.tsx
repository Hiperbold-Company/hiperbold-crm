/**
 * OS PROVEDORES DO SHELL NÃO MUDAM O CONTEXTO À TOA (11/11/2026).
 *
 * `VoiceCallProvider` e `ProvedorDeCoresDasEtiquetas` envolvem o shell inteiro
 * (`app/app/layout.tsx`), acima da página. Quando o valor de um contexto muda,
 * o React propaga a mudança até as fronteiras de Suspense ainda não hidratadas,
 * e a da página que chegou pelo streaming fica pendente por até ~300 ms (o React
 * agrupa as revelações). Mudança nessa janela faz o React descartar o HTML do
 * servidor e redesenhar a página no cliente, com a cópia do servidor ainda
 * escondida no `<body>`: a tela da Agenda existiu DUAS vezes no DOM e
 * `agenda-tela-do-produto.spec.ts` / `agenda-conectar-google.spec.ts`
 * reprovaram por strict mode.
 *
 * Medido no navegador: o `value` da sessão de voz era um objeto novo a cada
 * render do provedor, e a chegada de `/api/v1/tags/cores` trocava o `{}` vazio
 * por outro `{}`. Os dois casos abaixo prendem a propriedade que importa: o que
 * NÃO lê o dado não é acordado quando ele chega ou quando o provedor repinta.
 */
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { hydrateRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const espiao = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: espiao.get, post: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED" }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => {
  // Identidade estável, como o `useMemo` do AuthProvider de verdade.
  const auth = {
    user: { id: "22222222-2222-4222-8222-222222222222" },
    activeOrg: { orgId: "11111111-1111-4111-8111-111111111111", role: "agent" },
  };
  return { useAuth: () => auth, usePermission: () => true };
});

import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";
import {
  ProvedorDeCoresDasEtiquetas,
  useCorDaEtiqueta,
} from "@/components/tags/CoresDasEtiquetas";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sessão de voz: o valor do contexto só muda quando a sessão muda", () => {
  it("repintar sem mudança devolve o MESMO objeto, inclusive depois do boot sem ligação", async () => {
    espiao.get.mockResolvedValue({ data: [] });
    const ref = { current: null };
    const { result, rerender } = renderHook(() => useVoiceCallSession(ref));
    await waitFor(() => expect(espiao.get).toHaveBeenCalledTimes(1));
    // O boot terminou sem ligação ativa: nada mudou na sessão.
    await act(async () => {});
    const antes = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(antes);
  });

  it("e muda quando a sessão muda de verdade (ligação ativa no boot)", async () => {
    espiao.get.mockResolvedValue({
      data: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          status: "ringing",
          owner_user_id: null,
          created_by: null,
          started_at: new Date().toISOString(),
        },
      ],
    });
    const ref = { current: null };
    const { result } = renderHook(() => useVoiceCallSession(ref));
    const inicial = result.current;
    expect(inicial.call).toBeNull();
    await waitFor(() => expect(result.current.call?.id).toBe("55555555-5555-4555-8555-555555555555"));
    expect(result.current).not.toBe(inicial);
  });
});

describe("cores das etiquetas: a chegada das cores só acorda quem lê a cor", () => {
  it("o chip pinta quando as cores chegam", async () => {
    espiao.get.mockResolvedValue({ data: [{ tag: "vip", cor: "#00655a" }] });
    function Chip() {
      return <span data-testid="chip">{useCorDaEtiqueta("vip") ?? "sem-cor"}</span>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ProvedorDeCoresDasEtiquetas>
          <Chip />
        </ProvedorDeCoresDasEtiquetas>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("chip").textContent).toBe("sem-cor");
    await waitFor(() => expect(screen.getByTestId("chip").textContent).not.toBe("sem-cor"));
  });

  it("a chegada das cores NÃO redesenha no cliente a página que o servidor ainda está revelando", async () => {
    // O HTML de uma fronteira de Suspense PENDENTE, como o streaming entrega
    // antes do `$RC` revelar o conteúdo (o formato do Fizz: `<!--$?-->`).
    espiao.get.mockResolvedValue({ data: [{ tag: "vip", cor: "#00655a" }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pagina = <div data-testid="pagina">conteúdo</div>;
    function Chip() {
      return <span data-testid="chip">{useCorDaEtiqueta("vip") ?? "sem-cor"}</span>;
    }
    function Shell() {
      return (
        <QueryClientProvider client={qc}>
          <ProvedorDeCoresDasEtiquetas>
            <main>
              <Chip />
              <Suspense fallback={<p>carregando</p>}>{pagina}</Suspense>
            </main>
          </ProvedorDeCoresDasEtiquetas>
        </QueryClientProvider>
      );
    }
    // O React só trata `<!--$?-->` como "ainda chegando" com o documento em
    // `loading` — o jsdom nasce `complete`, e aí a fronteira vira erro de servidor.
    const readyState = Object.getOwnPropertyDescriptor(document, "readyState");
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    const container = document.createElement("div");
    container.innerHTML = '<main><span data-testid="chip">sem-cor</span><!--$?--><template id="B:0"></template><p>carregando</p><!--/$--></main>';
    document.body.appendChild(container);
    const erros: unknown[] = [];
    let raiz: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      raiz = hydrateRoot(container, <Shell />, { onRecoverableError: (e) => erros.push(e) });
    });
    await waitFor(() => expect(espiao.get).toHaveBeenCalled());
    // As cores CHEGARAM (o chip fora da fronteira pintou) — sem isto o caso
    // passaria por não ter acontecido nada.
    await waitFor(() => expect(screen.getByTestId("chip").textContent).toBe("#00655a"));
    // A fronteira continua esperando o servidor: nada foi desenhado no cliente.
    // Com o mapa no `value` do contexto, a troca de `{}` pelo mapa propagava até
    // a fronteira e o React a redesenhava aqui, com a cópia do servidor ainda
    // por chegar — a página duas vezes no DOM.
    expect(container.querySelector('[data-testid="pagina"]')).toBeNull();
    expect(container.textContent).toContain("carregando");
    expect(erros).toEqual([]);
    act(() => raiz?.unmount());
    container.remove();
    if (readyState) Object.defineProperty(document, "readyState", readyState);
    else delete (document as { readyState?: unknown }).readyState;
  });

  it("fora do provedor o chip continua saindo sem cor", () => {
    function Chip() {
      return <span data-testid="chip">{useCorDaEtiqueta("vip") ?? "sem-cor"}</span>;
    }
    render(<Chip />);
    expect(screen.getByTestId("chip").textContent).toBe("sem-cor");
  });
});
