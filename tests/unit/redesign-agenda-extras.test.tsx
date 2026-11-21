import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { Agendamento } from "@/components/agenda/tipos";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

/**
 * Redesign da Agenda, peças novas: painel de marcar, detalhe do compromisso e
 * células da visão de mês. Desligado, nenhum `data-rd-agenda`; ligado, aparecem.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: () => new Promise(() => {}), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const DIA = new Date("2026-09-16T12:00:00-03:00");
const AGENDAMENTOS = ["a-1", "a-2", "a-3"].map((id, i) => ({
  id,
  titulo: `Consulta ${i}`,
  responsavelId: "p-1",
  comeca: `2026-09-16T${13 + i}:00:00-03:00`,
  termina: `2026-09-16T${14 + i}:00:00-03:00`,
  origem: "ui",
  situacao: "confirmed",
})) as Agendamento[];

function emVolta(ligado: boolean, filho: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ProvedorDoRedesign ligado={ligado}>{filho}</ProvedorDoRedesign>
    </QueryClientProvider>
  );
}

const marcas = (raiz: ParentNode) =>
  Array.from(raiz.querySelectorAll("[data-rd-agenda]")).map((e) => e.getAttribute("data-rd-agenda"));

function mes(ligado: boolean) {
  return render(
    emVolta(
      ligado,
      <GradeDaAgenda
        visao="mes"
        ancora={DIA}
        agora={DIA}
        fuso="America/Sao_Paulo"
        agendamentos={AGENDAMENTOS}
        pessoas={[]}
      />,
    ),
  );
}

function painel(ligado: boolean) {
  return render(
    emVolta(
      ligado,
      <PainelDeMarcacao
        ancora={DIA}
        agora={DIA}
        responsavel={{ id: "p-1", nome: "Ana", trilha: 1 }}
        local="Online"
        horariosPorDia={{}}
        fuso="America/Sao_Paulo"
      />,
    ),
  );
}

function detalhe(ligado: boolean) {
  render(emVolta(ligado, <DetalheDoCompromisso id="a-1" onClose={() => {}} />));
  return document.body;
}

describe("redesign da Agenda (mês, painel, detalhe): desligado não marca nada", () => {
  it("mês", () => expect(marcas(mes(false).container)).toEqual([]));
  it("painel de marcar", () => expect(marcas(painel(false).container)).toEqual([]));
  it("detalhe", () => expect(marcas(detalhe(false))).toEqual([]));
});

describe("redesign da Agenda (mês, painel, detalhe): ligado marca as peças", () => {
  it("mês: células, números, hoje, outro mês, chips e +N", () => {
    const m = marcas(mes(true).container);
    for (const p of ["mes-celula", "mes-celula-fora", "mes-numero", "mes-numero-hoje", "mes-numero-fora", "mes-chip", "mes-mais"]) {
      expect(m).toContain(p);
    }
    expect(m.filter((p) => p === "mes-numero-hoje")).toHaveLength(1);
    expect(m.filter((p) => p === "mes-chip")).toHaveLength(2);
  });

  it("painel de marcar: coluna de contexto", () => {
    expect(marcas(painel(true).container)).toContain("marcar-contexto");
  });

  it("detalhe: a gaveta", () => {
    expect(marcas(detalhe(true))).toContain("detalhe");
  });
});
