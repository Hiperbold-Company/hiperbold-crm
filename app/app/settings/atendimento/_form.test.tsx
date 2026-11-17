import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "@/tests/helpers/render-com-confirmacao";

import { GrupoDeSalvar } from "@/components/configuracoes/grupo-de-salvar";

import { AssinaturaForm } from "./_assinatura-form";
import { AtendimentoForm, type AtendimentoConfig } from "./_form";
import {
  PRAZO_MAX_MINUTOS,
  PRAZO_MAX_MINUTOS_DEVOLUCAO,
} from "@/lib/escalacao/devolucao-automatica";

/**
 * A DEVOLUÇÃO AUTOMÁTICA TEM SUPERFÍCIE — e a superfície manda o que diz.
 *
 * O knob `handoff_return_after_minutes` nasceu com tela (invariante "toda
 * configuração tem superfície"). O que se prova aqui: desligado, o corpo do
 * PATCH leva `null` (a IA-06 de sempre); ligado, leva os minutos digitados — e
 * o campo de minutos só aparece quando está ligado.
 */

// A barra de salvar avisa ao sair sem salvar e navega pelo roteador do app.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetcher = vi.fn();

// O formulário invalida a leitura das conexões ao salvar: precisa de um QueryClient.
function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
});

const inicial: AtendimentoConfig = {
  mode: "manual",
  max_retries: 5,
  backoff_seconds: 60,
  visibility_mode: "all",
  handoff_return_after_minutes: null,
  conversation_stays_with_attendant: false,
  assign_owner_on_move: false,
  manual_reply_silence_minutes: null,
  conversation_connection_mode: "choose",
};

function corpoDoPatch(): Record<string, unknown> {
  const chamada = fetcher.mock.calls[0];
  expect(chamada, "o PATCH não saiu").toBeDefined();
  return JSON.parse((chamada![1] as { body: string }).body) as Record<string, unknown>;
}

describe("Distribuição de atendimento — devolver ao agente sozinho", () => {
  it("desligado por padrão: sem campo de minutos, e o corpo salvo leva null", async () => {
    montar(<AtendimentoForm initial={{ ...inicial, mode: "round_robin" }} />);
    expect(screen.getByTestId("devolver-sozinho")).not.toBeChecked();
    expect(screen.queryByLabelText("Minutos sem resposta da equipe")).not.toBeInTheDocument();

    // Mexe em outra coisa só para o Salvar destravar.
    fireEvent.click(screen.getByTestId("opcao-modo-manual"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ mode: "manual", handoff_return_after_minutes: null });
  });

  it("ligar sugere 60 min, aceita outro valor e o corpo salvo leva os minutos", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("devolver-sozinho"));

    const minutos = screen.getByLabelText("Minutos sem resposta da equipe");
    expect(minutos).toHaveValue(60);
    fireEvent.change(minutos, { target: { value: "45" } });

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ handoff_return_after_minutes: 45 });
  });

  it("desligar de novo volta a null — não guarda o número escondido", async () => {
    montar(<AtendimentoForm initial={{ ...inicial, handoff_return_after_minutes: 90 }} />);
    expect(screen.getByLabelText("Minutos sem resposta da equipe")).toHaveValue(90);
    fireEvent.click(screen.getByTestId("devolver-sozinho"));
    expect(screen.queryByLabelText("Minutos sem resposta da equipe")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ handoff_return_after_minutes: null });
  });

  /**
   * PRAZO LIVRE (#3313, item 3): o teto de 24 h caiu para ESTE campo.
   *
   * O defeito era o campo RECUSAR (e o cron descartar em silêncio) o prazo de
   * uma cotação com fornecedor: 5.000 minutos são três dias e meio, e a agência
   * de viagens da issue precisava exatamente disso. O teto do silêncio depois de
   * resposta pelo celular continua de 24 h — os dois campos deixaram de
   * compartilhar a mesma constante.
   *
   * ─── SABOTAGEM ────────────────────────────────────────────────────────────
   *   - voltar `max={PRAZO_MAX_MINUTOS}`: o primeiro caso acusa (o corpo salvo
   *     sairia truncado pelo navegador, e o campo anunciaria 24 h).
   */
  it("aceita 5.000 minutos: salva 5.000 no corpo e o campo anuncia o teto de 30 dias", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("devolver-sozinho"));

    const minutos = screen.getByLabelText("Minutos sem resposta da equipe");
    expect(minutos).toHaveAttribute("max", String(PRAZO_MAX_MINUTOS_DEVOLUCAO));
    fireEvent.change(minutos, { target: { value: "5000" } });

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ handoff_return_after_minutes: 5000 });
  });

  it("empresa com 5.000 minutos salvos vê 5.000 no campo ao recarregar", () => {
    montar(<AtendimentoForm initial={{ ...inicial, handoff_return_after_minutes: 5000 }} />);
    expect(screen.getByLabelText("Minutos sem resposta da equipe")).toHaveValue(5000);
  });

  it("controle do outro knob: o silêncio do celular continua com teto de 24 h", () => {
    montar(<AtendimentoForm initial={inicial} />);
    expect(screen.getByLabelText("Minutos de silêncio da IA depois de uma resposta pelo celular")).toHaveAttribute(
      "max",
      String(PRAZO_MAX_MINUTOS),
    );
  });
});

describe("Distribuição de atendimento — a conversa fica com quem atendeu", () => {
  it("desligado por padrão, e salvar outra coisa manda false", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    expect(screen.getByTestId("fica-com-quem-atendeu")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("opcao-modo-round_robin"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ conversation_stays_with_attendant: false });
  });

  it("ligar manda true", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("fica-com-quem-atendeu"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ conversation_stays_with_attendant: true });
  });

  it("empresa com o ajuste ligado vê a caixa marcada", () => {
    montar(<AtendimentoForm initial={{ ...inicial, conversation_stays_with_attendant: true }} />);
    expect(screen.getByTestId("fica-com-quem-atendeu")).toBeChecked();
  });
});

describe("Distribuição de atendimento — quem move um lead sem responsável assume", () => {
  it("desligado por padrão, com o texto simples, e salvar outra coisa manda false", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    expect(screen.getByTestId("dono-ao-mover-interruptor")).not.toBeChecked();
    expect(
      screen.getByText("Quem move um lead sem responsável passa a ser o responsável"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("opcao-modo-round_robin"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ assign_owner_on_move: false });
  });

  it("ligar manda true", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    fireEvent.click(screen.getByTestId("dono-ao-mover-interruptor"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ assign_owner_on_move: true });
  });

  it("empresa com a regra ligada vê a caixa marcada", () => {
    montar(<AtendimentoForm initial={{ ...inicial, assign_owner_on_move: true }} />);
    expect(screen.getByTestId("dono-ao-mover-interruptor")).toBeChecked();
  });
});

describe("Distribuição de atendimento — silêncio da IA depois de resposta pelo celular (#2005)", () => {
  const ROTULO = "Minutos de silêncio da IA depois de uma resposta pelo celular";

  it("empresa sem ajuste vê o padrão de 60, e salvar outra coisa não grava número nenhum", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    expect(screen.getByLabelText(ROTULO)).toHaveValue(60);
    fireEvent.click(screen.getByTestId("opcao-modo-round_robin"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ manual_reply_silence_minutes: null });
  });

  it("digitar 15 manda 15 no corpo salvo", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    fireEvent.change(screen.getByLabelText(ROTULO), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ manual_reply_silence_minutes: 15 });
  });

  it("empresa com 15 min salvos vê 15 no campo", () => {
    montar(<AtendimentoForm initial={{ ...inicial, manual_reply_silence_minutes: 15 }} />);
    expect(screen.getByLabelText(ROTULO)).toHaveValue(15);
  });
});

describe("Por qual conexão o atendente abre a conversa", () => {
  it("'Deixar escolher a conexão' vem marcado por padrão; escolher 'Só a conexão própria' vai no PATCH", async () => {
    montar(<AtendimentoForm initial={inicial} />);
    expect(screen.getByTestId("opcao-conexao-ao-abrir-choose")).toHaveAttribute("data-marcada", "sim");
    expect(screen.getByTestId("opcao-conexao-ao-abrir-own_only")).toHaveAttribute("data-marcada", "nao");

    fireEvent.click(screen.getByLabelText("Só a conexão própria"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({ conversation_connection_mode: "own_only" });
  });
});

describe("A tela inteira tem UMA barra de salvar", () => {
  const assinatura = { humanos: false, ia: false, nome_ia: "Assistente", por_agente: false };
  const barras = () => screen.queryAllByRole("region", { name: "Alterações não salvas" });
  // Resposta HTTP de verdade: o `apiClient` lê status e cabeçalhos, e aqui o
  // que se mede é a barra sumir porque as gravações deram certo.
  beforeEach(() => {
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  it("mudar a distribuição e a assinatura mostra uma barra só, e Salvar grava as duas rotas", async () => {
    montar(
      <GrupoDeSalvar>
        <AtendimentoForm initial={inicial} />
        <AssinaturaForm initial={assinatura} />
      </GrupoDeSalvar>,
    );
    expect(barras()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("opcao-modo-round_robin"));
    fireEvent.click(screen.getByTestId("assinatura-humanos"));
    expect(barras()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(barras()).toHaveLength(0));
    const rotas = fetcher.mock.calls.map(([url]) => String(url));
    expect(rotas.some((u) => u.endsWith("/api/v1/settings/routing"))).toBe(true);
    expect(rotas.some((u) => u.endsWith("/api/v1/settings/assinatura"))).toBe(true);
  });

  it("só o que mudou é gravado", async () => {
    montar(
      <GrupoDeSalvar>
        <AtendimentoForm initial={inicial} />
        <AssinaturaForm initial={assinatura} />
      </GrupoDeSalvar>,
    );
    fireEvent.click(screen.getByTestId("assinatura-ia"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(barras()).toHaveLength(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/api\/v1\/settings\/assinatura$/);
  });
});
