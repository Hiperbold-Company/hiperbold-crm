/**
 * Editar uma fonte de captação depois de criada (Automações e webhooks ›
 * Receber dados › detalhe da fonte).
 *
 * Os hooks de dados são os reais; só o transporte (`apiClient`) é trocado, para
 * o teste ver o que a tela MANDA para a API — o PATCH e o DELETE de verdade.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// O Select do Radix pede estas APIs do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    info: vi.fn(),
  },
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

let podeGerenciar = true;
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => podeGerenciar }));

const get = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: vi.fn(),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import { ApiError } from "@/lib/api/types";
import { EditSourceDialog } from "@/app/app/webhooks/_components/EditSourceDialog";
import { SourceDetail } from "@/app/app/webhooks/_components/SourceDetail";
import type { WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";

const FONTE: WebhookSourceRow = {
  id: "src-1",
  organization_id: "org-1",
  name: "Landing page",
  path_token: "tok123",
  is_active: true,
  kind: "form",
  last_received_at: null,
  default_pipeline_id: "p1",
  default_stage_id: "s1",
  redirect_to: "https://site.com/obrigado",
  field_map: { phone: ["form_fields[phone]", "zap"] },
  has_secret: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

const ETAPAS: Record<string, { id: string; name: string }[]> = {
  p1: [
    { id: "s1", name: "Novo" },
    { id: "s2", name: "Qualificado" },
  ],
  p2: [{ id: "s9", name: "Entrada pós-venda" }],
};

function rotear(url: string) {
  if (url === "/api/v1/pipelines") {
    return { data: [{ id: "p1", name: "Comercial" }, { id: "p2", name: "Pós-venda" }] };
  }
  const m = /^\/api\/v1\/pipelines\/(\w+)\/board$/.exec(url);
  if (m) return { data: { stages: ETAPAS[m[1]!] ?? [] } };
  if (url.startsWith("/api/v1/webhook-sources/")) return { data: [] };
  throw new Error(`GET inesperado: ${url}`);
}

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  podeGerenciar = true;
  get.mockImplementation(async (url: string) => rotear(url));
  patch.mockImplementation(async () => ({ data: FONTE }));
  del.mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("diálogo Editar fonte", () => {
  it("abre com os valores gravados da fonte", async () => {
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={() => {}} />);

    expect(screen.getByLabelText("Nome")).toHaveValue("Landing page");
    expect(screen.getByLabelText("Página de obrigado (opcional)")).toHaveValue("https://site.com/obrigado");
    expect(screen.getByLabelText("Campo do telefone")).toHaveValue("form_fields[phone], zap");
    expect(screen.getByLabelText("Campo do nome")).toHaveValue("");
    await waitFor(() => expect(screen.getByLabelText("Funil de entrada")).toHaveTextContent("Comercial"));
    await waitFor(() => expect(screen.getByLabelText("Estágio de entrada")).toHaveTextContent("Novo"));
  });

  it("trocar o funil limpa a etapa, e o PATCH leva funil e etapa juntos", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={fechar} />);
    await waitFor(() => expect(screen.getByLabelText("Estágio de entrada")).toHaveTextContent("Novo"));

    await user.click(screen.getByLabelText("Funil de entrada"));
    await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
    expect(screen.getByLabelText("Estágio de entrada")).not.toHaveTextContent("Novo");
    expect(screen.getByLabelText("Estágio de entrada")).toHaveTextContent("Escolha o estágio");

    // Sem etapa, não salva.
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(patch).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Escolha o funil e o estágio de entrada.");

    await waitFor(() => expect(screen.getByLabelText("Estágio de entrada")).toBeEnabled());
    await user.click(screen.getByLabelText("Estágio de entrada"));
    await user.click(await screen.findByRole("option", { name: "Entrada pós-venda" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/webhook-sources/src-1", {
      default_pipeline_id: "p2",
      default_stage_id: "s9",
    });
    await waitFor(() => expect(fechar).toHaveBeenCalledWith(false));
    expect(toastSuccess).toHaveBeenCalledWith("Fonte atualizada.");
  });

  it("manda só o que mudou: nome, obrigado removido e campos do formulário", async () => {
    const user = userEvent.setup();
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={() => {}} />);

    const nome = screen.getByLabelText("Nome");
    await user.clear(nome);
    await user.type(nome, "  LP Black Friday ");
    await user.clear(screen.getByLabelText("Página de obrigado (opcional)"));
    await user.type(screen.getByLabelText("Campo do nome"), "seu_nome, ,  primeiro_nome");
    await user.clear(screen.getByLabelText("Campo do telefone"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/webhook-sources/src-1", {
      name: "LP Black Friday",
      redirect_to: null,
      // Telefone em branco SAI do mapa: aí valem os nomes comuns.
      field_map: { name: ["seu_nome", "primeiro_nome"] },
    });
  });

  it("sem mudança nenhuma, fecha sem chamar a API", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={fechar} />);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(patch).not.toHaveBeenCalled();
    expect(fechar).toHaveBeenCalledWith(false);
  });

  it("página de obrigado sem http(s) é recusada na tela, antes da API", async () => {
    const user = userEvent.setup();
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={() => {}} />);
    const campo = screen.getByLabelText("Página de obrigado (opcional)");
    await user.clear(campo);
    await user.type(campo, "site.com/obrigado");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(patch).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "A página de obrigado precisa ser um endereço completo, começando com https://",
    );
  });

  it("recusa da API vira a mensagem dela, e o diálogo continua aberto", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    patch.mockRejectedValueOnce(
      new ApiError(
        422,
        "unprocessable_entity",
        undefined,
        "req-1",
        "Essa etapa foi arquivada e não aparece mais no quadro. Escolha uma etapa em uso.",
      ),
    );
    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={fechar} />);
    await user.type(screen.getByLabelText("Nome"), " 2");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Essa etapa foi arquivada e não aparece mais no quadro. Escolha uma etapa em uso.",
        expect.anything(),
      ),
    );
    expect(fechar).not.toHaveBeenCalled();
  });

  it("a ajuda lista exatamente os nomes que a rota de entrada reconhece sozinha", () => {
    const fonte = readFileSync(path.join(process.cwd(), "lib/webhooks/inbound.ts"), "utf8");
    const bloco = /const DEFAULT_FIELD_MAP[^{]*\{([\s\S]*?)\n\};/.exec(fonte)?.[1] ?? "";
    const lista = (campo: string) =>
      [...(new RegExp(`${campo}: \\[([^\\]]*)\\]`).exec(bloco)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
        .map((m) => m[1])
        .join(", ");
    expect(lista("phone")).not.toBe("");

    comQuery(<EditSourceDialog source={FONTE} open onOpenChange={() => {}} />);
    for (const campo of ["name", "phone", "email"] as const) {
      expect(screen.getByText(lista(campo))).toBeInTheDocument();
    }
  });
});

describe("detalhe da fonte: editar, pausar e excluir", () => {
  it("Editar abre o diálogo com a fonte", async () => {
    const user = userEvent.setup();
    comQuery(<SourceDetail source={FONTE} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(await screen.findByRole("dialog", { name: "Editar fonte" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nome")).toHaveValue("Landing page");
  });

  it("excluir pede confirmação antes do DELETE, e diz o que acontece com os leads", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    comQuery(<SourceDetail source={FONTE} open onOpenChange={fechar} />);

    await user.click(screen.getByRole("button", { name: "Excluir fonte" }));
    expect(del).not.toHaveBeenCalled();
    const confirmacao = await screen.findByRole("alertdialog");
    expect(confirmacao).toHaveTextContent("Os leads e contatos que já chegaram continuam no funil");
    expect(confirmacao).toHaveTextContent("O endereço para de funcionar na hora");

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/webhook-sources/src-1"));
    await waitFor(() => expect(fechar).toHaveBeenCalledWith(false));
  });

  it("cancelar a confirmação não apaga nada", async () => {
    const user = userEvent.setup();
    comQuery(<SourceDetail source={FONTE} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Excluir fonte" }));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(del).not.toHaveBeenCalled();
  });

  it("DELETE recusado: mostra o erro e a fonte continua aberta", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    del.mockRejectedValueOnce(new ApiError(403, "forbidden_permission", undefined, "req-2"));
    comQuery(<SourceDetail source={FONTE} open onOpenChange={fechar} />);
    await user.click(screen.getByRole("button", { name: "Excluir fonte" }));
    await user.click(await screen.findByRole("button", { name: "Excluir" }));
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "Seu perfil não tem permissão para isso. Fale com o administrador.",
        expect.anything(),
      ),
    );
    expect(fechar).not.toHaveBeenCalled();
  });

  it("pausar manda is_active=false", async () => {
    const user = userEvent.setup();
    comQuery(<SourceDetail source={FONTE} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/webhook-sources/src-1", { is_active: false }),
    );
  });

  it("sem a permissão automacoes.gerenciar, Editar, o interruptor e Excluir somem", () => {
    podeGerenciar = false;
    comQuery(<SourceDetail source={FONTE} open onOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Excluir fonte" })).toBeNull();
    // O que não muda nada continua: copiar o endereço.
    expect(screen.getByText("Endereço da fonte")).toBeInTheDocument();
  });
});
