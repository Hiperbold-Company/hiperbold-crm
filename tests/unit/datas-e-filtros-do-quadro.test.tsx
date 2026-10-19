import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltroDeDataPopover } from "@/components/kanban/FiltroDeDataPopover";
import { LeadDossier } from "@/components/kanban/LeadDossier";
import {
  dentroDoFiltroDeData,
  diaNoFuso,
  filtroDeDataFromParams,
  idadeEmDias,
  intervaloDoFiltro,
  rotuloDeIdade,
  somaDias,
  formataDataNoFuso,
  normalizaPeriodo,
  ultimaMovimentacao,
  type FiltroDeData,
} from "@/lib/kanban/datas-do-lead";
import { applyFilters, filtersFromParams, filtersToParams } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

const SP = "America/Sao_Paulo";
/** 19/out/2026, 22h em São Paulo = 20/out 01h UTC: o dia do fuso e o do UTC DIFEREM. */
const AGORA = new Date("2026-10-20T01:00:00.000Z");

describe("dia no fuso da organização", () => {
  it("22h em São Paulo ainda é o dia 19, embora em UTC já seja 20", () => {
    expect(diaNoFuso(AGORA, SP)).toBe("2026-10-19");
    expect(diaNoFuso(AGORA, "UTC")).toBe("2026-10-20");
  });
  it("fuso inexistente não lança: cai no do navegador", () => {
    expect(diaNoFuso(AGORA, "Nao/Existe")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("somaDias atravessa mês e ano", () => {
    expect(somaDias("2026-03-01", -1)).toBe("2026-02-28");
    expect(somaDias("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("intervalo e pertinência dos atalhos", () => {
  const dentro = (iso: string, f: FiltroDeData) => dentroDoFiltroDeData(iso, f, AGORA, SP);

  it("Hoje: o dia 19 de São Paulo (e não o 20 do UTC)", () => {
    expect(intervaloDoFiltro({ predefinido: "hoje" }, AGORA, SP)).toEqual({ de: "2026-10-19", ate: "2026-10-19" });
    // 19/out 15h em SP = 18h UTC: hoje. 18/out 23h em SP: ontem.
    expect(dentro("2026-10-19T18:00:00Z", { predefinido: "hoje" })).toBe(true);
    expect(dentro("2026-10-19T02:00:00Z", { predefinido: "hoje" })).toBe(false); // 18/out 23h em SP
  });

  it("Últimos 7 dias inclui hoje e os 6 anteriores; Últimos 30, hoje e os 29 anteriores", () => {
    expect(intervaloDoFiltro({ predefinido: "7d" }, AGORA, SP)).toEqual({ de: "2026-10-13", ate: "2026-10-19" });
    expect(intervaloDoFiltro({ predefinido: "30d" }, AGORA, SP)).toEqual({ de: "2026-09-20", ate: "2026-10-19" });
    expect(dentro("2026-10-13T12:00:00Z", { predefinido: "7d" })).toBe(true);
    expect(dentro("2026-10-12T12:00:00Z", { predefinido: "7d" })).toBe(false);
  });

  it("Este mês: do dia 1 até hoje", () => {
    expect(intervaloDoFiltro({ predefinido: "mes" }, AGORA, SP)).toEqual({ de: "2026-10-01", ate: "2026-10-19" });
    expect(dentro("2026-10-01T12:00:00Z", { predefinido: "mes" })).toBe(true);
    expect(dentro("2026-09-30T12:00:00Z", { predefinido: "mes" })).toBe(false);
  });

  it("período personalizado: as duas pontas valem inclusive; ponta ausente é aberta", () => {
    const f = { de: "2026-10-05", ate: "2026-10-10" };
    expect(dentro("2026-10-05T12:00:00Z", f)).toBe(true);
    expect(dentro("2026-10-10T12:00:00Z", f)).toBe(true);
    expect(dentro("2026-10-11T12:00:00Z", f)).toBe(false);
    expect(dentro("2026-10-04T12:00:00Z", f)).toBe(false);
    expect(dentro("2020-01-01T12:00:00Z", { ate: "2026-10-10" })).toBe(true);
    expect(dentro("2030-01-01T12:00:00Z", { de: "2026-10-10" })).toBe(true);
  });

  it("sem filtro, tudo passa; com filtro, data ausente não passa", () => {
    expect(dentroDoFiltroDeData(null, undefined, AGORA, SP)).toBe(true);
    expect(dentroDoFiltroDeData(null, { predefinido: "hoje" }, AGORA, SP)).toBe(false);
  });
});

const lead = (id: string, created_at: string, stage_changed_at?: string | null): Lead =>
  ({
    id,
    title: id,
    status: "open",
    owner_user_id: null,
    owner_agent_id: null,
    tags: [],
    created_at,
    stage_changed_at,
  }) as unknown as Lead;

describe("filtros do quadro: Criado em e Última movimentação", () => {
  const velho = lead("velho", "2026-01-10T12:00:00Z", "2026-10-18T12:00:00Z"); // criado em janeiro, movido ontem
  const novo = lead("novo", "2026-10-19T15:00:00Z", null); // criado hoje, sem carimbo de etapa
  const todos = [velho, novo];
  const ctx = { timezone: SP, agora: AGORA };

  it("a última movimentação cai em created_at quando o carimbo é nulo", () => {
    expect(ultimaMovimentacao(novo)).toBe("2026-10-19T15:00:00Z");
    expect(ultimaMovimentacao(velho)).toBe("2026-10-18T12:00:00Z");
  });

  it("Criado em e Última movimentação filtram eixos DIFERENTES", () => {
    const criadoHoje = applyFilters(todos, { createdAt: { predefinido: "hoje" } }, ctx);
    expect(criadoHoje.map((l) => l.id)).toEqual(["novo"]);
    const movidoSemana = applyFilters(todos, { movedAt: { predefinido: "7d" } }, ctx);
    expect(movidoSemana.map((l) => l.id)).toEqual(["velho", "novo"]);
    const criadoSemana = applyFilters(todos, { createdAt: { predefinido: "7d" } }, ctx);
    expect(criadoSemana.map((l) => l.id)).toEqual(["novo"]);
  });

  it("os dois filtros se somam entre si e com os outros", () => {
    const r = applyFilters(
      todos,
      { createdAt: { de: "2026-01-01", ate: "2026-01-31" }, movedAt: { predefinido: "7d" }, owner: "unassigned" },
      ctx,
    );
    expect(r.map((l) => l.id)).toEqual(["velho"]);
  });

  it("sem filtro de data nada muda (os cards de antes continuam todos)", () => {
    expect(applyFilters(todos, {}, ctx)).toHaveLength(2);
  });

  it("o fuso decide: lead criado às 01h UTC do dia 20 é do dia 19 em São Paulo", () => {
    const l = lead("fuso", "2026-10-20T00:30:00Z");
    expect(applyFilters([l], { createdAt: { predefinido: "hoje" } }, { timezone: SP, agora: AGORA })).toHaveLength(1);
    expect(applyFilters([l], { createdAt: { predefinido: "hoje" } }, { timezone: "UTC", agora: AGORA })).toHaveLength(1);
    const ontemEmSP = lead("fuso2", "2026-10-19T02:00:00Z"); // 18/out 23h em SP
    expect(applyFilters([ontemEmSP], { createdAt: { predefinido: "hoje" } }, { timezone: SP, agora: AGORA })).toHaveLength(0);
  });
});

describe("filtros de data na URL (como os filtros existentes)", () => {
  const sp = (qs: string) => new URLSearchParams(qs);

  it("ida e volta: atalho e período personalizado", () => {
    const f = {
      status: "all" as const,
      createdAt: { predefinido: "30d" as const },
      movedAt: { de: "2026-10-01", ate: "2026-10-15" },
    };
    const qs = filtersToParams(f);
    expect(qs).toContain("criado=30d");
    expect(qs).toContain("mov_de=2026-10-01");
    expect(qs).toContain("mov_ate=2026-10-15");
    const volta = filtersFromParams(sp(qs));
    expect(volta.createdAt).toEqual({ predefinido: "30d" });
    expect(volta.movedAt).toEqual({ de: "2026-10-01", ate: "2026-10-15" });
  });

  it("valor inválido na URL é ignorado, não quebra", () => {
    expect(filtroDeDataFromParams(sp("criado=ontem&criado_de=lixo"), "criado")).toBeUndefined();
  });

  it("sem filtro de data a query string não ganha nada", () => {
    expect(filtersToParams({ status: "all" })).toBe("");
  });
});

describe("período invertido e formato por fuso", () => {
  it("'de' depois de 'até' é normalizado (as pontas trocam), no filtro e no helper", () => {
    expect(normalizaPeriodo({ de: "2026-10-15", ate: "2026-10-05" })).toEqual({ de: "2026-10-05", ate: "2026-10-15" });
    expect(intervaloDoFiltro({ de: "2026-10-15", ate: "2026-10-05" }, AGORA, SP)).toEqual({
      de: "2026-10-05",
      ate: "2026-10-15",
    });
    expect(dentroDoFiltroDeData("2026-10-10T12:00:00Z", { de: "2026-10-15", ate: "2026-10-05" }, AGORA, SP)).toBe(true);
  });

  it("formataDataNoFuso respeita o fuso e não lança com fuso inválido", () => {
    expect(formataDataNoFuso("2026-09-02T01:00:00Z", SP, "pt-BR")).toBe("01/09/2026");
    expect(formataDataNoFuso("2026-09-02T01:00:00Z", "UTC", "pt-BR")).toBe("02/09/2026");
    expect(formataDataNoFuso("2026-09-02T01:00:00Z", "Nao/Existe", "pt-BR")).toMatch(/\d{2}\/\d{2}\/2026/);
    expect(formataDataNoFuso("lixo", SP)).toBe("");
  });

  it("o formatador é reaproveitado: milhares de cards não constroem milhares de Intl", () => {
    const Original = Intl.DateTimeFormat;
    let construcoes = 0;
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function (...args: ConstructorParameters<typeof Original>) {
      construcoes++;
      return new Original(...args);
    };
    try {
      for (let i = 0; i < 500; i++) diaNoFuso("2026-10-19T12:00:00Z", "Europe/Lisbon");
      // no máximo uma construção para este fuso (o resto vem do cache)
      expect(construcoes).toBeLessThanOrEqual(1);
    } finally {
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Original;
    }
  });
});

describe("rótulo relativo do card", () => {
  const agora = new Date("2026-10-19T15:00:00Z");
  it("conta em dias do fuso", () => {
    expect(idadeEmDias("2026-10-19T12:00:00Z", agora, SP)).toBe(0);
    expect(idadeEmDias("2026-10-16T12:00:00Z", agora, SP)).toBe(3);
    // 23h50 de ontem e 00h10 de hoje (SP) são 1 dia de diferença, apesar de 20 min
    expect(idadeEmDias("2026-10-19T02:50:00Z", new Date("2026-10-19T03:10:00Z"), SP)).toBe(1);
  });
  it("hoje, ontem, há N dias, há N meses", () => {
    expect(rotuloDeIdade("2026-10-19T12:00:00Z", agora, SP)).toBe("hoje");
    expect(rotuloDeIdade("2026-10-18T12:00:00Z", agora, SP)).toBe("ontem");
    expect(rotuloDeIdade("2026-10-16T12:00:00Z", agora, SP)).toBe("há 3 dias");
    expect(rotuloDeIdade("2026-06-19T12:00:00Z", agora, SP)).toBe("há 4 meses");
  });
});

afterEach(cleanup);

describe("FiltroDeDataPopover", () => {
  function Caixa({ inicial }: { inicial?: FiltroDeData }) {
    const [v, setV] = useState<FiltroDeData | undefined>(inicial);
    return (
      <>
        <FiltroDeDataPopover id="criado" titulo="Criado em" valor={v} onChange={setV} />
        <output data-testid="valor">{JSON.stringify(v ?? null)}</output>
      </>
    );
  }
  const valor = () => JSON.parse(screen.getByTestId("valor").textContent!);

  it("mostra 'Qualquer data' e oferece os quatro atalhos", async () => {
    render(<Caixa />);
    const botao = screen.getByRole("button", { name: /Criado em: Qualquer data/ });
    await userEvent.click(botao);
    for (const nome of ["Hoje", "Últimos 7 dias", "Últimos 30 dias", "Este mês"]) {
      expect(screen.getByRole("button", { name: nome })).toBeInTheDocument();
    }
  });

  it("escolher um atalho filtra e muda o rótulo; 'Qualquer data' limpa", async () => {
    render(<Caixa />);
    await userEvent.click(screen.getByRole("button", { name: /Criado em/ }));
    await userEvent.click(screen.getByRole("button", { name: "Últimos 7 dias" }));
    expect(valor()).toEqual({ predefinido: "7d" });
    expect(screen.getByRole("button", { name: /Criado em: Últimos 7 dias/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Qualquer data" }));
    expect(valor()).toBeNull();
  });

  it("período personalizado: de/até viram o filtro, e trocar para um atalho descarta o período", async () => {
    render(<Caixa />);
    await userEvent.click(screen.getByRole("button", { name: /Criado em/ }));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Até"), { target: { value: "2026-10-15" } });
    expect(valor()).toEqual({ de: "2026-10-01", ate: "2026-10-15" });
    await userEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(valor()).toEqual({ predefinido: "hoje" });
  });
});

// ── A ficha mostra as duas datas ────────────────────────────────────────────────
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useFusoDaOrganizacao: () => "America/Sao_Paulo",
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [],
    chegouAoVivo: new Set(),
    isLoading: false,
    isError: false,
    realtimeStatus: "subscribed",
    seguranca: { divergencias: 0 },
    temMais: false,
    carregandoMais: false,
    carregarMais: async () => {},
    revelarEvento: async () => {},
  }),
}));
vi.mock("@/components/kanban/ContatoDoNegocio", () => ({ ContatoDoNegocio: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/kanban/LeadFieldsForm", () => ({ LeadFieldsForm: () => null }));
vi.mock("@/components/kanban/RegistrarEvento", () => ({ RegistrarEvento: () => null }));
vi.mock("@/components/kanban/LeadTimeline", () => ({ LeadTimeline: () => null }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));

describe("ficha do negócio: Criado em e Última movimentação", () => {
  const base = {
    id: "l1",
    title: "Maria — Pós",
    value_cents: null,
    currency: null,
    contact_id: null,
    owner_user_id: null,
    owner_agent_id: null,
    owner_kind: null,
    conversa: null,
    created_at: "2026-09-01T12:00:00Z",
    stage_changed_at: "2026-10-10T12:00:00Z",
  } as unknown as Lead;

  function ficha(lead: Lead) {
    return render(
      <LeadDossier open onOpenChange={() => {}} lead={lead} pipelineId="p" stageName="Inscrito" />,
    );
  }

  it("mostra a data de criação e a da última movimentação perto da etapa", () => {
    ficha(base);
    const linha = document.querySelector("[data-datas-do-negocio]") as HTMLElement;
    expect(linha).toBeTruthy();
    expect(within(linha).getByText(/Criado em/)).toBeInTheDocument();
    expect(linha.textContent).toContain("Última movimentação");
    expect(linha.textContent).toMatch(/01\/09\/2026/);
    expect(linha.textContent).toMatch(/10\/10\/2026/);
  });

  it("as datas saem no FUSO da organização, não no do navegador: 01h UTC do dia 2 é 22h do dia 1 em São Paulo", () => {
    ficha({ ...base, created_at: "2026-09-02T01:00:00Z" } as Lead);
    const linha = document.querySelector("[data-datas-do-negocio]") as HTMLElement;
    expect(linha.textContent).toMatch(/Criado em 01\/09\/2026, 22:00/);
  });

  it("sem carimbo de etapa, a última movimentação é a criação", () => {
    ficha({ ...base, stage_changed_at: null } as Lead);
    const linha = document.querySelector("[data-datas-do-negocio]") as HTMLElement;
    expect(linha.textContent!.match(/01\/09\/2026/g)).toHaveLength(2);
  });
});
