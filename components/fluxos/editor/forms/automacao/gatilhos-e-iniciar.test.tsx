/**
 * O editor dos gatilhos do lote 3 e da ação "Iniciar outra automação": o que a
 * pessoa preenche na tela vira uma config que o MOTOR aceita (os schemas de
 * `lib/automacoes/schemas.ts`, os mesmos do publish), e o que o schema recusa
 * nunca sobe para o canvas.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  automacaoTriggerConfigSchema,
  automacaoTriggerSchema,
  crmActionConfigSchema,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
  type CrmActionConfig,
} from "@/lib/automacoes/schemas";

import type * as Canais from "@/hooks/channels/useChannelSessions";

import { AutomationTriggerForm } from "./AutomationTriggerForm";
import { CrmActionForm } from "./CrmActionForm";

const ESTA = "11111111-1111-4111-8111-111111111111";
const BOAS_VINDAS = "22222222-2222-4222-8222-222222222222";
const RASCUNHO = "33333333-3333-4333-8333-333333333333";
const CANAL_VENDAS = "44444444-4444-4444-8444-444444444444";
const CANAL_SUPORTE = "55555555-5555-4555-8555-555555555555";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
  useActiveOrg: () => ({ orgId: "org-1" }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => ({
  ...(await original<typeof Canais>()),
  useChannelSessions: () => ({
    data: [
      { id: CANAL_VENDAS, display_name: "Vendas", phone_number: null },
      { id: CANAL_SUPORTE, display_name: null, phone_number: "5511999990000" },
    ],
    isLoading: false,
    isError: false,
    schemaOutdated: false,
  }),
}));
vi.mock("@/hooks/contacts/useEtiquetasParaEscolher", () => ({
  useEtiquetasParaEscolher: () => ({ data: [{ tag: "VIP", cor: null, grupo: null }] }),
}));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useFollowupFlows: () => ({
    data: [
      { id: ESTA, name: "Esta automação", status: "active" },
      { id: BOAS_VINDAS, name: "Boas-vindas", status: "active" },
      { id: RASCUNHO, name: "Ainda em rascunho", status: "draft" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
}));

function montar(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const usuario = () => userEvent.setup({ delay: null });

function ultima<T>(fn: ReturnType<typeof vi.fn>): T {
  const chamadas = fn.mock.calls;
  expect(chamadas.length).toBeGreaterThan(0);
  return chamadas[chamadas.length - 1]![0] as T;
}

/** O gatilho que subiu por último, conferido nos dois schemas do motor. */
function gatilhoGravado(onChange: ReturnType<typeof vi.fn>): AutomacaoTrigger {
  const config = ultima<AutomacaoTriggerConfig>(onChange);
  expect(automacaoTriggerConfigSchema.safeParse(config).success).toBe(true);
  const g = config.triggers[0]!;
  expect(automacaoTriggerSchema.safeParse(g).success).toBe(true);
  return g;
}

async function escolherGatilho(kind: AutomacaoTrigger["kind"], flowId?: string) {
  const onChange = vi.fn();
  montar(
    <AutomationTriggerForm
      config={{}}
      onChange={onChange}
      {...(flowId !== undefined ? { flowId } : {})}
    />,
  );
  await usuario().selectOptions(screen.getByTestId("gatilho-0-tipo"), kind);
  return onChange;
}

describe("AutomationTriggerForm — gatilhos do lote 3", () => {
  it("mensagem recebida: palavras, números e opções viram config válida", async () => {
    const onChange = await escolherGatilho("message_received");
    const u = usuario();

    // "Qualquer mensagem" já serve, e a proteção do atendente nasce ligada.
    expect(gatilhoGravado(onChange)).toEqual({
      kind: "message_received",
      match: "any",
      keywords: [],
    });
    expect(screen.getByTestId("gatilho-0-sem-atendente")).toBeChecked();
    expect(
      screen.getByText("Compara palavras inteiras, sem acento e sem diferenciar maiúsculas."),
    ).toBeInTheDocument();

    // "Contém" sem palavra: o schema recusa, e nada sobe.
    const antes = onChange.mock.calls.length;
    await u.selectOptions(screen.getByTestId("gatilho-0-modo"), "contains");
    expect(onChange.mock.calls.length).toBe(antes);
    expect(screen.getByTestId("gatilho-erro")).toHaveTextContent(
      "Complete o gatilho: informe ao menos uma palavra-chave.",
    );

    // Palavra só de pontuação: recusada com a mensagem do schema, fora da lista.
    await u.type(screen.getByTestId("gatilho-0-palavra"), "!!!");
    await u.click(screen.getByTestId("gatilho-0-palavra-adicionar"));
    expect(screen.getByTestId("gatilho-0-palavra-erro")).toHaveTextContent(
      "a palavra-chave precisa ter ao menos uma letra ou número",
    );
    expect(screen.queryByTestId("gatilho-0-palavra-chip-0")).toBeNull();
    expect(onChange.mock.calls.length).toBe(antes);

    await u.clear(screen.getByTestId("gatilho-0-palavra"));
    await u.type(screen.getByTestId("gatilho-0-palavra"), "preço{Enter}");
    // A mesma palavra com outra grafia não entra de novo.
    await u.type(screen.getByTestId("gatilho-0-palavra"), "PRECO{Enter}");
    expect(screen.getByTestId("gatilho-0-palavra-erro")).toHaveTextContent("já está na lista");

    await u.click(screen.getByLabelText("5511999990000"));
    await u.click(screen.getByTestId("gatilho-0-so-primeira"));
    await u.click(screen.getByTestId("gatilho-0-sem-atendente"));

    expect(gatilhoGravado(onChange)).toEqual({
      kind: "message_received",
      match: "contains",
      keywords: ["preço"],
      channel_session_ids: [CANAL_SUPORTE],
      only_first_message: true,
      skip_if_human: false,
    });

    // Desmarcar o único número volta a "qualquer número" (a chave some).
    await u.click(screen.getByLabelText("5511999990000"));
    expect(gatilhoGravado(onChange)).not.toHaveProperty("channel_session_ids");
  });

  it("tag adicionada: tag existente e digitada, no contato, com o aviso das tags em massa", async () => {
    const onChange = await escolherGatilho("tag_added");
    const u = usuario();
    expect(
      screen.getByText("Tags postas em massa (ação em lote ou planilha) não disparam a automação."),
    ).toBeInTheDocument();

    await u.selectOptions(screen.getByTestId("gatilho-0-alvo"), "contact");
    await u.selectOptions(screen.getByTestId("gatilho-0-tag-existente"), "VIP");
    await u.type(screen.getByTestId("gatilho-0-tag"), "cliente novo{Enter}");

    expect(gatilhoGravado(onChange)).toEqual({
      kind: "tag_added",
      target: "contact",
      tags: ["VIP", "cliente novo"],
    });
  });

  it("agendamento: os acontecimentos marcados, e sem nenhum o schema recusa", async () => {
    const onChange = await escolherGatilho("appointment");
    const u = usuario();
    const eventos = screen.getByTestId("gatilho-0-eventos");
    expect(within(eventos).getAllByRole("checkbox")).toHaveLength(6);

    await u.click(screen.getByTestId("gatilho-0-evento-no_show"));
    await u.click(screen.getByTestId("gatilho-0-evento-confirmed"));
    expect(gatilhoGravado(onChange)).toEqual({
      kind: "appointment",
      events: ["created", "confirmed", "no_show"],
    });

    await u.click(screen.getByTestId("gatilho-0-evento-created"));
    await u.click(screen.getByTestId("gatilho-0-evento-confirmed"));
    const antes = onChange.mock.calls.length;
    await u.click(screen.getByTestId("gatilho-0-evento-no_show"));
    expect(onChange.mock.calls.length).toBe(antes);
    expect(screen.getByTestId("gatilho-erro")).toHaveTextContent(
      "marque ao menos um acontecimento",
    );
  });

  it("aniversário: sem campos, com o horário real da varredura", async () => {
    const onChange = await escolherGatilho("birthday");
    expect(gatilhoGravado(onChange)).toEqual({ kind: "birthday" });
    expect(screen.getByText("No dia do aniversário do contato, às 9h.")).toBeInTheDocument();
  });

  it("data de um campo do negócio: dias depois, horário e só abertos", async () => {
    const onChange = await escolherGatilho("date_field");
    const u = usuario();
    expect(gatilhoGravado(onChange)).toEqual({
      kind: "date_field",
      field: { scope: "lead", key: "expected_close_date" },
      offset_days: 0,
      time: "09:00",
    });
    expect(screen.getByTestId("gatilho-0-so-abertos")).toBeChecked();

    await u.clear(screen.getByTestId("gatilho-0-dias"));
    await u.type(screen.getByTestId("gatilho-0-dias"), "3");
    expect(gatilhoGravado(onChange)).toMatchObject({ offset_days: -3 });
    await u.selectOptions(screen.getByTestId("gatilho-0-sentido"), "depois");
    fireEvent.change(screen.getByTestId("gatilho-0-horario"), { target: { value: "14:30" } });
    await u.click(screen.getByTestId("gatilho-0-so-abertos"));

    expect(gatilhoGravado(onChange)).toEqual({
      kind: "date_field",
      field: { scope: "lead", key: "expected_close_date" },
      offset_days: 3,
      time: "14:30",
      only_open: false,
    });

    // Passou de 365: a última config válida fica (40), e o aviso diz o limite.
    await u.clear(screen.getByTestId("gatilho-0-dias"));
    await u.type(screen.getByTestId("gatilho-0-dias"), "40");
    const antes = onChange.mock.calls.length;
    await u.type(screen.getByTestId("gatilho-0-dias"), "0");
    expect(onChange.mock.calls.length).toBe(antes);
    expect(gatilhoGravado(onChange)).toMatchObject({ offset_days: 40 });
    expect(screen.getByTestId("gatilho-erro")).toHaveTextContent("de 0 a 365 dias");
  });

  it("sem resposta: tempo em horas vira minutos, e menos de 5 minutos é recusado", async () => {
    const onChange = await escolherGatilho("no_reply");
    const u = usuario();
    expect(
      screen.getByText(/Conta a partir da última mensagem enviada ao contato/),
    ).toBeInTheDocument();

    await u.selectOptions(screen.getByTestId("gatilho-0-tempo-unidade"), "horas");
    await u.clear(screen.getByTestId("gatilho-0-tempo"));
    await u.type(screen.getByTestId("gatilho-0-tempo"), "2");
    expect(gatilhoGravado(onChange)).toEqual({
      kind: "no_reply",
      after_minutes: 120,
      only_if_last_was_outbound: true,
    });

    const antes = onChange.mock.calls.length;
    await u.selectOptions(screen.getByTestId("gatilho-0-tempo-unidade"), "minutos");
    expect(onChange.mock.calls.length).toBe(antes);
    expect(screen.getByTestId("gatilho-erro")).toHaveTextContent("de 5 minutos a 30 dias");
  });

  it("caso aberto na Central: sem campos", async () => {
    const onChange = await escolherGatilho("case_opened");
    expect(gatilhoGravado(onChange)).toEqual({ kind: "case_opened" });
  });

  it("iniciada por outra automação: só das escolhidas, e a própria não aparece", async () => {
    const onChange = await escolherGatilho("started_by_automation", ESTA);
    const u = usuario();
    expect(gatilhoGravado(onChange)).toEqual({ kind: "started_by_automation" });
    expect(screen.getByText(/\{\{param\.chave\}\}/)).toBeInTheDocument();

    await u.selectOptions(screen.getByTestId("gatilho-0-aceitar"), "lista");
    const lista = screen.getByTestId("gatilho-0-iniciadoras");
    expect(within(lista).queryByLabelText("Esta automação")).toBeNull();
    await u.click(within(lista).getByLabelText("Boas-vindas"));
    expect(gatilhoGravado(onChange)).toEqual({
      kind: "started_by_automation",
      from_pointer_ids: [BOAS_VINDAS],
    });

    await u.selectOptions(screen.getByTestId("gatilho-0-aceitar"), "qualquer");
    expect(gatilhoGravado(onChange)).toEqual({ kind: "started_by_automation" });
  });
});

describe("CrmActionForm — Iniciar outra automação", () => {
  const inicial: CrmActionConfig = {
    actions: [{ type: "add_tags", target: "lead", tags: ["x"] }],
    on_error: "route",
  };

  it("escolhe uma automação ativa (nunca a própria) e passa dados com chave válida", async () => {
    const onChange = vi.fn();
    montar(<CrmActionForm config={inicial} onChange={onChange} flowId={ESTA} />);
    const u = usuario();

    await u.selectOptions(screen.getByTestId("acao-0-tipo"), "start_automation");
    const seletor = screen.getByTestId("acao-0-automacao");
    const opcoes = within(seletor)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    expect(opcoes).toEqual(["", BOAS_VINDAS]);

    await u.selectOptions(seletor, BOAS_VINDAS);
    expect(ultima<CrmActionConfig>(onChange).actions[0]).toEqual({
      type: "start_automation",
      pointer_id: BOAS_VINDAS,
      params: [],
    });
    expect(screen.getByText("Iniciar a automação “Boas-vindas”")).toBeInTheDocument();

    // Chave fora do padrão: aviso no campo, e a config não sobe.
    await u.click(screen.getByTestId("acao-0-adicionar-dado"));
    const antes = onChange.mock.calls.length;
    await u.type(screen.getByTestId("acao-0-dado-0-chave"), "Cupom!");
    // `{{` é a tecla de escape do user-event: "{{{{" digita "{{".
    await u.type(screen.getByTestId("acao-0-dado-0-valor"), "{{{{contact.name}}");
    expect(onChange.mock.calls.length).toBe(antes);
    expect(screen.getByTestId("acao-0-dado-0-erro")).toHaveTextContent(
      "Use letras minúsculas, números e underscore",
    );

    await u.clear(screen.getByTestId("acao-0-dado-0-chave"));
    await u.type(screen.getByTestId("acao-0-dado-0-chave"), "cupom_1");
    expect(screen.queryByTestId("acao-0-dado-0-erro")).toBeNull();

    const config = ultima<CrmActionConfig>(onChange);
    expect(crmActionConfigSchema.safeParse(config).success).toBe(true);
    expect(config.actions[0]).toEqual({
      type: "start_automation",
      pointer_id: BOAS_VINDAS,
      params: [{ key: "cupom_1", value: "{{contact.name}}" }],
    });
  });

  it("chave repetida é recusada", async () => {
    const onChange = vi.fn();
    const comDado: CrmActionConfig = {
      actions: [
        {
          type: "start_automation",
          pointer_id: BOAS_VINDAS,
          params: [{ key: "cupom", value: "10" }],
        },
      ],
      on_error: "route",
    };
    montar(<CrmActionForm config={comDado} onChange={onChange} flowId={ESTA} />);
    const u = usuario();
    await u.click(screen.getByTestId("acao-0-adicionar-dado"));
    await u.type(screen.getByTestId("acao-0-dado-1-chave"), "cupo");
    const antes = onChange.mock.calls.length;
    await u.type(screen.getByTestId("acao-0-dado-1-chave"), "m");
    expect(screen.getByTestId("acao-0-dado-1-erro")).toHaveTextContent("já está na lista");
    expect(onChange.mock.calls.length).toBe(antes);
    const gravada = ultima<CrmActionConfig>(onChange).actions[0];
    expect(gravada).toMatchObject({ params: [{ key: "cupom" }, { key: "cupo" }] });
  });
});
