/**
 * Cupom de desconto na tela de assinar (0955): o campo "Tem um cupom?" no resumo (passo 4), o desconto
 * mostrado (preço cheio riscado, linha do cupom, total da primeira cobrança, aviso da renovação), a nova
 * simulação quando o cliente troca ciclo ou forma de pagamento, a remoção, e a entrada enviada na compra.
 *
 * O limite é a ação de servidor: `simularCupom` aqui responde como o banco responderia (percentual sobre o
 * preço do ciclo, recusa por ciclo), e `iniciarAssinatura` é espiada. A conta do desconto e as regras do
 * cupom são provadas no banco (`tests/invariants/cupons-banco.test.ts`); aqui se mede o que a pessoa vê e o
 * que a tela manda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const iniciarAssinatura = vi.fn();
const comprarPacote = vi.fn();
const simularCupom = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({
  iniciarAssinatura: (...args: unknown[]) => iniciarAssinatura(...args),
  comprarPacote: (...args: unknown[]) => comprarPacote(...args),
  simularCupom: (...args: unknown[]) => simularCupom(...args),
}));

import { AssinarOuComprarClient } from "@/app/app/settings/plano/assinar/_client";
import { MENSAGEM_AGUARDE_ESPELHO } from "@/app/app/settings/plano/_logica-compra";
import { opcoesDeParcelamento } from "@/lib/billing/asaas/parcelamento";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";

const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };

const PRO: PlanoParaVenda = {
  code: "pro",
  name: "Pro",
  version: 1,
  forSale: true,
  priceMonthlyCents: 19900,
  priceSemiannualCents: 104900,
  priceYearlyCents: 189900,
  conexoes: 3,
};

const OPCOES = {
  pro: {
    semiannual: opcoesDeParcelamento(104900, "semiannual", PARAMETROS),
    yearly: opcoesDeParcelamento(189900, "yearly", PARAMETROS),
  },
};

const PRECO_DO_CICLO = { monthly: 19900, semiannual: 104900, yearly: 189900 } as const;
type Ciclo = keyof typeof PRECO_DO_CICLO;

type EntradaDaSimulacao = { codigo: string; planCode: string; ciclo: Ciclo; metodo: string; parcelas?: number };

/** Como o banco responde, em miniatura: PCT10 dá 10%, SEMESTRAL só vale no semestral, EXPIRADO expirou. */
function respostaDoBanco(e: EntradaDaSimulacao) {
  const codigo = e.codigo.toUpperCase();
  if (codigo === "EXPIRADO") return { tipo: "erro", mensagem: "Este cupom expirou." };
  if (codigo === "SEMESTRAL" && e.ciclo !== "semiannual") {
    return { tipo: "erro", mensagem: "Este cupom não vale para este período de cobrança." };
  }
  if (codigo !== "PCT10" && codigo !== "SEMESTRAL") return { tipo: "erro", mensagem: "Cupom inválido. Confira o código e tente de novo." };
  const precoCheioCents = PRECO_DO_CICLO[e.ciclo];
  const descontoCents = Math.round(precoCheioCents * 0.1);
  return {
    tipo: "ok",
    codigo,
    tipoDoDesconto: "percentual",
    valor: 10,
    precoCheioCents,
    descontoCents,
    totalCents: precoCheioCents - descontoCents,
    parcelas: e.parcelas ?? 1,
    totalFinalCents: precoCheioCents - descontoCents,
  };
}

function tela(extra: { pacotes?: never[] } = {}) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <AssinarOuComprarClient
        planos={[PRO]}
        pixDisponivel
        pacotes={extra.pacotes ?? []}
        precisaPagador={false}
        leituraFalhou={false}
        opcoesDeParcelas={OPCOES}
        taxaMensalPercentual={1.99}
        planoAtualCode={null}
      />
    </IdiomaProvider>,
  );
}

const reais = (valor: string) => new RegExp(`R\\$\\s*${valor.replace(/\./g, "\\.")}`);
const continuar = () => fireEvent.click(screen.getByTestId("continuar"));
const aceitar = () => fireEvent.click(document.getElementById("termos-plano-pro") as HTMLElement);

/** Plano Pro no ciclo pedido, cartão, termos aceitos, e abre o resumo. */
function irAoResumo(ciclo: Ciclo = "monthly") {
  fireEvent.click(screen.getByTestId("escolher-pro"));
  if (ciclo !== "monthly") fireEvent.click(screen.getByTestId(`ciclo-pro-${ciclo}`));
  continuar();
  aceitar();
  continuar();
}

async function aplicar(codigo: string) {
  const abrir = screen.queryByTestId("cupom-abrir");
  if (abrir) fireEvent.click(abrir);
  fireEvent.change(screen.getByTestId("cupom-codigo"), { target: { value: codigo } });
  fireEvent.click(screen.getByTestId("cupom-aplicar"));
}

beforeEach(() => {
  iniciarAssinatura.mockReset();
  iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
  comprarPacote.mockReset();
  simularCupom.mockReset();
  simularCupom.mockImplementation(async (e: EntradaDaSimulacao) => respostaDoBanco(e));
});
afterEach(() => cleanup());

describe("o campo do cupom no resumo", () => {
  it("começa discreto: só 'Tem um cupom?', e o campo abre ao clicar", () => {
    tela();
    irAoResumo();

    expect(screen.getByTestId("cupom-abrir")).toHaveTextContent("Tem um cupom?");
    expect(screen.queryByTestId("cupom-codigo")).toBeNull();

    fireEvent.click(screen.getByTestId("cupom-abrir"));
    expect(screen.getByTestId("cupom-codigo")).toBeInTheDocument();
    expect(screen.getByTestId("cupom-aplicar")).toHaveTextContent("Aplicar");
    expect(simularCupom).not.toHaveBeenCalled();
  });

  it("aplicar sem digitar nada pede o código e não chama o servidor", () => {
    tela();
    irAoResumo();

    fireEvent.click(screen.getByTestId("cupom-abrir"));
    fireEvent.click(screen.getByTestId("cupom-aplicar"));

    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Digite o código do cupom.");
    expect(simularCupom).not.toHaveBeenCalled();
  });

  it("os pacotes de tokens não têm o campo: ele só existe no resumo do plano", () => {
    tela({ pacotes: [{ codigo: "mil", nome: "Mil", tokens: 1000, precoCents: 5000 }] as never[] });

    const pacotes = document.getElementById("pacotes") as HTMLElement;
    expect(within(pacotes).queryByText(/cupom/i)).toBeNull();
    // Nem no plano, antes de chegar ao resumo.
    expect(screen.queryByTestId("cupom-abrir")).toBeNull();
  });
});

describe("aplicar o cupom", () => {
  it("cupom válido: pergunta ao servidor com a escolha atual e mostra preço cheio riscado, o desconto, o total e a renovação", async () => {
    tela();
    irAoResumo();

    await aplicar("pct10");

    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());
    expect(simularCupom).toHaveBeenCalledWith({ codigo: "pct10", planCode: "pro", ciclo: "monthly", metodo: "CREDIT_CARD", parcelas: 1 });

    expect(screen.getByTestId("resumo-preco-cheio").textContent).toMatch(reais("199,00"));
    expect(screen.getByTestId("resumo-preco-cheio").querySelector("dd")).toHaveClass("line-through");
    expect(screen.getByTestId("resumo-cupom").textContent).toContain("PCT10");
    expect(screen.getByTestId("resumo-cupom").textContent).toContain("10%");
    expect(screen.getByTestId("resumo-cupom").textContent).toMatch(reais("19,90"));
    expect(screen.getByTestId("resumo-total")).toHaveTextContent("Total da primeira cobrança");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("179,10"));
    expect(screen.getByTestId("cupom-renovacao").textContent).toContain("O desconto vale só na primeira cobrança.");
    expect(screen.getByTestId("cupom-renovacao").textContent).toMatch(/R\$\s*199,00\s+por mês\./);
    // O campo some: o cupom está aplicado.
    expect(screen.queryByTestId("cupom-codigo")).toBeNull();
  });

  it("a renovação diz o período do ciclo: semestre no semestral, ano no anual", async () => {
    tela();
    irAoResumo("semiannual");
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("cupom-renovacao")).toBeInTheDocument());
    expect(screen.getByTestId("cupom-renovacao").textContent).toMatch(/R\$\s*1\.049,00\s+por semestre\./);
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("944,10"));
  });

  it("o Enter no campo aplica, como o botão", async () => {
    tela();
    irAoResumo();
    fireEvent.click(screen.getByTestId("cupom-abrir"));
    fireEvent.change(screen.getByTestId("cupom-codigo"), { target: { value: "PCT10" } });
    fireEvent.keyDown(screen.getByTestId("cupom-codigo"), { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());
  });

  it("cupom recusado: mostra a frase em português, mantém o campo aberto e o total no preço cheio", async () => {
    tela();
    irAoResumo();

    await aplicar("EXPIRADO");

    await waitFor(() => expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Este cupom expirou."));
    expect(screen.getByTestId("cupom-codigo")).toBeInTheDocument();
    expect(screen.queryByTestId("resumo-cupom")).toBeNull();
    expect(screen.queryByTestId("cupom-renovacao")).toBeNull();
    expect(screen.getByTestId("resumo-total")).toHaveTextContent("Total a pagar");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("199,00"));
  });

  it("falha de rede ao conferir: mensagem de tentar de novo, sem cupom aplicado", async () => {
    simularCupom.mockRejectedValue(new Error("rede"));
    tela();
    irAoResumo();

    await aplicar("PCT10");

    await waitFor(() => expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Não foi possível conferir o cupom agora"));
    expect(screen.queryByTestId("resumo-cupom")).toBeNull();
  });
});

describe("trocar a escolha com o cupom aplicado", () => {
  it("trocar o ciclo simula de novo e mostra o valor do ciclo novo, nunca o velho", async () => {
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("179,10")));

    // Alterar o ciclo: volta ao passo 2, escolhe o semestral e retorna ao resumo.
    fireEvent.click(within(screen.getByTestId("resumo-ciclo")).getByRole("button", { name: /Alterar/ }));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    continuar();

    await waitFor(() => expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("944,10")));
    expect(simularCupom).toHaveBeenLastCalledWith({ codigo: "PCT10", planCode: "pro", ciclo: "semiannual", metodo: "CREDIT_CARD", parcelas: 1 });
    expect(screen.getByTestId("resumo-total").textContent).not.toMatch(reais("179,10"));
    expect(screen.getByTestId("cupom-renovacao").textContent).toMatch(/R\$\s*1\.049,00\s+por semestre\./);
  });

  it("enquanto confere de novo, o valor velho não aparece e o botão de assinar fica desligado", async () => {
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    let responder!: (v: unknown) => void;
    simularCupom.mockImplementationOnce(() => new Promise((resolve) => (responder = resolve)));
    fireEvent.click(within(screen.getByTestId("resumo-ciclo")).getByRole("button", { name: /Alterar/ }));
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    continuar();
    continuar();

    await waitFor(() => expect(screen.getByTestId("cupom-conferindo")).toBeInTheDocument());
    expect(screen.queryByTestId("resumo-cupom")).toBeNull();
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.899,00"));
    expect(screen.getByTestId("assinar-pro")).toBeDisabled();

    responder(respostaDoBanco({ codigo: "PCT10", planCode: "pro", ciclo: "yearly", metodo: "CREDIT_CARD" }));
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.709,10"));
    expect(screen.getByTestId("assinar-pro")).not.toBeDisabled();
  });

  it("cupom que deixa de valer no ciclo novo sai, com o motivo, e a compra segue sem ele", async () => {
    tela();
    irAoResumo("semiannual");
    await aplicar("SEMESTRAL");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId("resumo-ciclo")).getByRole("button", { name: /Alterar/ }));
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    continuar();
    continuar();

    await waitFor(() => expect(screen.getByTestId("cupom-erro")).toBeInTheDocument());
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Cupom removido.");
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Este cupom não vale para este período de cobrança.");
    expect(screen.queryByTestId("resumo-cupom")).toBeNull();
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.899,00"));

    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).not.toHaveProperty("cupom");
  });
});

describe("remover o cupom", () => {
  it("volta ao preço cheio, sem a linha do cupom, e o campo 'Tem um cupom?' volta", async () => {
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("cupom-remover"));

    expect(screen.queryByTestId("resumo-cupom")).toBeNull();
    expect(screen.queryByTestId("resumo-preco-cheio")).toBeNull();
    expect(screen.queryByTestId("cupom-renovacao")).toBeNull();
    expect(screen.getByTestId("resumo-total")).toHaveTextContent("Total a pagar");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("199,00"));
    expect(screen.getByTestId("cupom-abrir")).toBeInTheDocument();
  });
});

describe("confirmar a compra com cupom", () => {
  it("manda o código no iniciarAssinatura junto com a mesma entrada de sempre", async () => {
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({
      planCode: "pro",
      ciclo: "monthly",
      metodo: "CREDIT_CARD",
      cupom: "PCT10",
    });
  });

  it("sem cupom a entrada não leva a chave 'cupom'", async () => {
    tela();
    irAoResumo();

    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).not.toHaveProperty("cupom");
  });

  it("mudou o cupom depois de um 'aguarde': a chave de idempotência é NOVA (o servidor recusa mesma chave com cupom diferente)", async () => {
    iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: MENSAGEM_AGUARDE_ESPELHO });
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("assinar-pro")).not.toBeDisabled());
    const chaveComCupom = iniciarAssinatura.mock.calls[0]![0].chave as string;

    // Tira o cupom e tenta de novo: mesma escolha de plano, ciclo e método, cupom diferente.
    fireEvent.click(screen.getByTestId("cupom-remover"));
    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(2));
    const chaveSemCupom = iniciarAssinatura.mock.calls[1]![0].chave as string;

    expect(iniciarAssinatura.mock.calls[1]![0]).not.toHaveProperty("cupom");
    expect(chaveSemCupom).not.toBe(chaveComCupom);
  });

  it("repetir a MESMA escolha com o MESMO cupom depois de um 'aguarde' reaproveita a chave", async () => {
    iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: MENSAGEM_AGUARDE_ESPELHO });
    tela();
    irAoResumo();
    await aplicar("PCT10");
    await waitFor(() => expect(screen.getByTestId("resumo-cupom")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("assinar-pro")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(2));

    expect(iniciarAssinatura.mock.calls[1]![0].chave).toBe(iniciarAssinatura.mock.calls[0]![0].chave);
    expect(iniciarAssinatura.mock.calls[1]![0].cupom).toBe("PCT10");
  });
});
