/**
 * O editor de CAMPOS do funil — o que ele oferece e o que ele deixa editar.
 *
 * O defeito que estes testes trancam: a lista de tipos desta tela era digitada
 * à mão e ficou menor que a de `customFieldSchema`. `multiselect` era aceito
 * pelo schema, gravado pela API e desenhado no dossiê do contato, mas não
 * existia aqui — então um campo desse tipo abria com o seletor EM BRANCO (nenhum
 * `SelectItem` casava com o `value`) e sem a linha de opções, que só aparecia
 * para `select`. Quem administrava via um campo aparentemente corrompido, sem
 * como editar, e o conserto intuitivo (escolher um tipo qualquer para tirar o
 * branco) rebaixava a escolha múltipla para escolha única.
 *
 * Por isso os testes medem o par: a tela OFERECE todo tipo que o schema aceita,
 * e mostra as opções para TODO tipo de lista fechada — não só para `select`.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { customFieldSchema } from "@/lib/schemas/settings";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções irmãs falam com a API; este arquivo é sobre os CAMPOS.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import { ROTULOS_DO_TIPO } from "@/lib/schemas/rotulos-do-campo";
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";
import {
  PipelinesClient,
  TIPOS_DE_CAMPO,
  tipoTemOpcoes,
  type EtapaDoFunil,
  type PipelineRow,
} from "./_client";

/**
 * OS DOIS "ABRIR" DA TELA (issue #3176) — o editor do funil e a lista de um campo.
 *
 * O editor de um funil só MONTA quando ele é expandido, e as opções de um campo
 * de lista nascem RECOLHIDAS num resumo. Por isso todo caso que olha para
 * dentro do editor (ou para as opções) abre o que quer ver antes de medir — e é
 * só isso: o comportamento testado abaixo é o de sempre.
 */
function abrirEditores(): void {
  // Com mais de um funil, cada card nasce RECOLHIDO no acordeão (feat/duplicar-funil):
  // o corpo fica `hidden` e o `getByRole` não o enxerga. Abre todos antes.
  const todos = screen.queryByTestId("alternar-todos-os-funis");
  if (todos && /Abrir todos/i.test(todos.textContent ?? "")) fireEvent.click(todos);
  const botoes = screen.queryAllByRole("button", {
    name: /Editar vocabulário e campos deste funil/i,
  });
  for (const botao of botoes) fireEvent.click(botao);
}




/** Um funil de clínica: o campo que importa é a lista de procedimentos, e ela é múltipla. */
const FUNIL: PipelineRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tratamentos",
  slug: "tratamentos",
  vocabulary: { lead: "Paciente", deal: "Tratamento", won: "Fechado", lost: "Perdido" },
  settings: {
    fields: [
      {
        key: "procedimentos_de_interesse",
        label: "Procedimentos de interesse",
        type: "multiselect",
        options: [
          { value: "clareamento", label: "Clareamento Dental" },
          { value: "implantes", label: "Implantes" },
        ],
      },
    ],
  },
};

describe("tipos de campo que a tela do funil oferece", () => {
  it("oferece TODO tipo que o schema aceita — lista menor deixa campo salvo sem seletor", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    const daTela = [...TIPOS_DE_CAMPO].sort();
    expect(daTela).toEqual(doSchema);
  });

  it("mostra as opções para toda lista fechada, não só para `select`", () => {
    expect(tipoTemOpcoes("select")).toBe(true);
    expect(tipoTemOpcoes("multiselect")).toBe(true);
    // Um tipo de texto livre não tem lista para editar.
    expect(tipoTemOpcoes("text")).toBe(false);
    expect(tipoTemOpcoes("date")).toBe(false);
  });
});

/**
 * O SELETOR DE TIPO FALA A LÍNGUA DE QUEM CONFIGURA (issue #3037).
 *
 * O dono do negócio via `multiselect` e `searchable_select` no seletor sem
 * saber qual era a lista de várias escolhas e qual era a pesquisável. O `value`
 * continua técnico — é o que o schema e a API gravam —, mas o texto que a
 * pessoa lê passa a ser um rótulo em português, pelo `t()`.
 */
describe("rótulos dos tipos de campo (#3037)", () => {
  it("o mapa cobre TODO tipo do schema, e nenhum rótulo é o nome técnico", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    expect(Object.keys(ROTULOS_DO_TIPO).sort()).toEqual(doSchema);

    for (const tipo of doSchema) {
      const rotulo = ROTULOS_DO_TIPO[tipo];
      expect(rotulo.trim().length, `rótulo vazio para ${tipo}`).toBeGreaterThan(0);
      expect(rotulo, `${tipo} continua com nome técnico`).not.toBe(tipo);
    }
  });

});

/**
 * A COLUNA DO TIPO NÃO PODE CORTAR O RÓTULO (issue #3099).
 *
 * Com `md:grid-cols-[1fr_1fr_8rem_auto]`, o gatilho ficava com ~91 px de texto:
 * "Lista de várias escolhas" (152 px) e "Lista de varias opciones" (154 px)
 * apareciam cortados, sem reticências. A coluna agora tem 13rem (208 px, ~172 px
 * de texto) — 18 px de folga sobre o maior rótulo em espanhol.
 *
 * O jsdom não mede layout, então este teste guarda o que o código DECLARA (a
 * largura da coluna e o `title` com o rótulo inteiro). A medida real por
 * `getBoundingClientRect`, em pt e es, é a prova pela tela.
 */
describe("editor de obrigatorio_em do funil (#1536, desde a 1015 só a regra)", () => {
  it("não cria nem edita campo: aponta para Configurações › Campos Personalizados", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();
    expect(screen.queryByRole("button", { name: /Adicionar campo/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Gerenciar campos em Configurações › Campos Personalizados" }),
    ).toHaveAttribute("href", "/app/settings/campos-personalizados");
  });

  const ETAPA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ETAPA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const FUNIL_MARCADO_ID = "33333333-3333-4333-8333-333333333333";
  const ETAPAS: Record<string, EtapaDoFunil[]> = {
    [FUNIL.id]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
    [FUNIL_MARCADO_ID]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
  };
  /** Um campo JÁ marcado no settings — o estado de quem abre para desligar. */
  const FUNIL_MARCADO: PipelineRow = {
    id: FUNIL_MARCADO_ID,
    name: "Vendas",
    slug: "vendas-marcado",
    vocabulary: null,
    settings: {
      fields: [
        {
          key: "dor",
          label: "Dor",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_A], ao_perder: true },
        },
      ],
    },
  };

  const tela = (p: PipelineRow) => {
    render(<PipelinesClient pipelines={[p]} etapas={ETAPAS} podeEditarConfig />);
    abrirEditores();
  };
  const patchSalvo = () => vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1];

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("oferece as etapas do funil + ao ganhar + ao perder, e nada vem marcado", () => {
    tela(FUNIL);

    expect(
      screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText("Exigir em Proposta (antiga) — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Ao ganhar — Procedimentos de interesse")).not.toBeChecked();
    expect(screen.getByLabelText("Ao perder — Procedimentos de interesse")).not.toBeChecked();
  });

  it("a marca vira `obrigatorio_em` no patch da porta única de escrita", () => {
    tela(FUNIL);

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"));
    fireEvent.click(screen.getByLabelText("Ao ganhar — Procedimentos de interesse"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(updatePipelineConfig).toHaveBeenCalledTimes(1);
    // 1015: a regra vai em `campos_obrigatorios` (o banco a junta à definição da organização);
    // `fields` não sai mais desta tela.
    expect(patchSalvo()).not.toHaveProperty("fields");
    expect(patchSalvo().campos_obrigatorios).toEqual({
      procedimentos_de_interesse: { etapas: [ETAPA_A], ao_ganhar: true },
    });
  });

  it("desmarcar tudo apaga a chave — o funil volta ao comportamento de antes", () => {
    tela(FUNIL_MARCADO);
    expect(screen.getByLabelText("Exigir em Avaliação — Dor")).toBeChecked();
    expect(screen.getByLabelText("Ao perder — Dor")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Dor"));
    fireEvent.click(screen.getByLabelText("Ao perder — Dor"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(patchSalvo().campos_obrigatorios).toEqual({});
  });

  it("a etapa ARQUIVADA fica visível e marcável — o que alguém já marcou não some", () => {
    tela(FUNIL_MARCADO);
    // A regra gravada aponta para ETAPA_A; ETAPA_B (arquivada) também aparece.
    const antiga = screen.getByLabelText("Exigir em Proposta (antiga) — Dor");
    expect(antiga).toBeInTheDocument();
    // O rótulo da coluna morta vem da própria lista, marcada — some da tela só
    // quando some do settings, nunca por baixo de quem a marcou.
    expect(antiga.closest("label")?.textContent).toContain("arquivada");
  });
});

describe("retomada de negócio encerrado (#1538)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

  it("nasce desligada e ligar grava `reabertura: novo_negocio` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig />);
    abrirEditores();
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("novo_negocio");
  });

  it("funil já ligado abre marcado, e desligar volta a `mesmo_registro`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, reabertura: "novo_negocio" } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    abrirEditores();
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("mesmo_registro");
  });
});

describe("comanda do ganho (#1477)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
  const ROTULO = "Abrir comanda ao ganhar um negócio neste funil";

  it("nasce desligada e ligar grava `comanda_no_ganho: true` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig comandaDisponivel />);
    abrirEditores();
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });

  it("funil já ligado abre marcado, e desligar grava `false`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig comandaDisponivel />);
    abrirEditores();
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(false);
  });

  it("sem o módulo financeiro (#1907) o interruptor some, e salvar não mexe no valor gravado", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    abrirEditores();
    expect(screen.queryByLabelText(ROTULO)).toBeNull();

    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });
});

describe("organização sem nenhum funil", () => {
  it("manda criar em Funis, com link — e não para quem instalou o sistema", () => {
    // O texto dizia que criar funil "é feito por quem instalou o sistema, direto
    // no banco". Falso desde que a lista de Funis ganhou o botão "Novo funil":
    // o dono ficava procurando alguém para fazer o que ele mesmo faz num clique.
    render(<PipelinesClient pipelines={[]} podeEditarConfig />);
    const vazio = screen.getByTestId("sem-funil-configuracao");
    expect(vazio.textContent).not.toMatch(/banco|quem instalou/i);
    const funis = NAV_DESTINATIONS.find((d) => d.href === "/app/kanban");
    expect(funis).toBeTruthy();
    const link = screen.getByTestId("link-criar-funil");
    expect(link.getAttribute("href")).toBe(funis!.href);
    expect(link.textContent).toContain(funis!.label);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A ETAPA DE ENTRADA DAS CONVERSAS DO INBOX, PELA TELA (#3011 — CR do PR #3250).
 *
 * O ajuste já existia no BANCO: a etapa declarada valia, o fallback era
 * provado, e NINGUÉM CONSEGUIA LIGAR — nenhum ponto da interface mandava
 * `entrada_do_inbox` no patch que a tela envia ao `updatePipelineConfig`.
 *
 * O que estes casos prendem é o caminho inteiro: o admin escolhe a etapa NA
 * TELA, a escolha sai no patch da porta única de escrita, a tela reaberta
 * mostra a escolha feita — e, quando a etapa escolhida deixa de valer, o aviso
 * aparece em vez de a queda para a primeira etapa virar silêncio.
 */
describe("etapa de entrada das conversas do Inbox na tela (#3011)", () => {
  const ETAPA_ABERTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OUTRA_ABERTA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ETAPA_ARQUIVADA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ETAPA_GANHO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const ETAPAS_DE_ENTRADA: Record<string, EtapaDoFunil[]> = {
    [FUNIL.id]: [
      { id: ETAPA_ABERTA, name: "Em atendimento", is_archived: false },
      { id: OUTRA_ABERTA, name: "Proposta", is_archived: false },
      { id: ETAPA_ARQUIVADA, name: "Antiga", is_archived: true },
      { id: ETAPA_GANHO, name: "Fechado", is_archived: false, is_won: true },
    ],
  };

  const funilCom = (settings: Record<string, unknown>): PipelineRow => ({
    ...FUNIL,
    settings: { ...FUNIL.settings, ...settings },
  });

  // O editor do funil só monta expandido (#3176): o seletor mora dentro dele.
  // E o seletor só existe no funil de entrada: por padrão, `p` é o padrão.
  const montar = (p: PipelineRow) => {
    const r = render(
      <PipelinesClient pipelines={[{ is_default: true, ...p }]} etapas={ETAPAS_DE_ENTRADA} podeEditarConfig />,
    );
    abrirEditores();
    return r;
  };
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
  const patchSalvo = () => vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1];
  const seletor = () => screen.getByLabelText("Etapa de entrada das conversas do Inbox");

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("o seletor só aparece no funil que o servidor lê: o padrão e o de clientes, nunca um secundário", () => {
    // `funilDeEntrada` consulta `entrada_do_inbox` só no `is_default` e no
    // `is_client_pipeline`. Num secundário a escolha seria salva e nunca usada.
    const SECUNDARIO: PipelineRow = {
      ...FUNIL,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Pós-venda",
      slug: "pos-venda",
      is_default: false,
    };
    const etapas = { ...ETAPAS_DE_ENTRADA, [SECUNDARIO.id]: ETAPAS_DE_ENTRADA[FUNIL.id]! };
    const rotulo = "Etapa de entrada das conversas do Inbox";

    const { unmount } = render(
      <PipelinesClient pipelines={[{ ...FUNIL, is_default: true }, SECUNDARIO]} etapas={etapas} podeEditarConfig />,
    );
    abrirEditores();
    expect(screen.getAllByRole("button", { name: /Salvar vocabulário e campos/i })).toHaveLength(2);
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(1);
    unmount();

    const { unmount: desmontar } = render(
      <PipelinesClient pipelines={[SECUNDARIO]} etapas={etapas} podeEditarConfig />,
    );
    abrirEditores();
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(0);
    desmontar();

    render(
      <PipelinesClient
        pipelines={[{ ...SECUNDARIO, is_client_pipeline: true }]}
        etapas={etapas}
        podeEditarConfig
      />,
    );
    abrirEditores();
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(1);
  });

  it("abre na primeira etapa quando o funil não declara nada, e sem aviso", () => {
    montar(FUNIL);

    expect(seletor().textContent?.trim()).toBe("Primeira etapa do funil (padrão)");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("o admin ESCOLHE a etapa na tela e a escolha vai no patch do updatePipelineConfig", async () => {
    const user = userEvent.setup();
    montar(FUNIL);

    await user.click(seletor());
    await user.click(await screen.findByRole("option", { name: "Em atendimento" }));
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    // A chave só existe aqui porque a TELA a mandou: é este o elo que faltava
    // entre o ajuste do banco e quem configura.
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: true, stage_id: ETAPA_ABERTA });
  });

  it("a tela reabre mostrando a escolha feita, e salvar mantém a decisão", async () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ABERTA } }));

    expect(seletor().textContent?.trim()).toBe("Em atendimento");
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: true, stage_id: ETAPA_ABERTA });
  });

  it("não oferece etapa arquivada nem de ganho — a gravação no banco as recusaria", async () => {
    const user = userEvent.setup();
    montar(FUNIL);

    await user.click(seletor());
    expect(await screen.findByRole("option", { name: "Em atendimento" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Antiga/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Fechado/ })).toBeNull();
  });

  it("funil que nunca declarou nada NÃO ganha a chave morta no patch", async () => {
    montar(FUNIL);

    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    // O settings de um funil intocado continua idêntico ao de antes do #3011.
    expect(patchSalvo()).not.toHaveProperty("entrada_do_inbox");
  });

  it("desligar GUARDA a etapa escolhida: religar não obriga a escolher de novo", async () => {
    const user = userEvent.setup();
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ABERTA } }));

    await user.click(seletor());
    await user.click(
      await screen.findByRole("option", { name: "Primeira etapa do funil (padrão)" }),
    );
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: false, stage_id: ETAPA_ABERTA });
  });

  it("etapa que deixou de valer: AVISO visível, e a escolha continua à mostra", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ARQUIVADA } }));

    expect(screen.getByRole("alert").textContent).toContain("primeira etapa do funil");
    expect(seletor().textContent?.trim()).toBe("Antiga (indisponível)");
  });

  it("etapa apagada (nem aparece na lista) também avisa, como removida", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(seletor().textContent?.trim()).toBe("Etapa removida (indisponível)");
  });

  it("ajuste DESLIGADO com etapa lembrada não avisa — não há queda acontecendo", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: false, stage_id: ETAPA_ABERTA } }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(seletor().textContent?.trim()).toBe("Primeira etapa do funil (padrão)");
  });
});

/**
 * O RECORTE DE ENCERRADOS ANTIGOS DO QUADRO (#2995) — o controle no editor.
 *
 * Este arquivo mede a PONTE da tela: o valor que já estava salvo volta marcado e
 * com os dias relidos, e o que a pessoa salva sai no payload do
 * `updatePipelineConfig`. Quem grava a chave no settings é a action (medida em
 * `app/actions/settings/updatePipelineConfig.test.ts`) e quem monta o quadro é a
 * rota (medida em `app/api/v1/pipelines/[id]/board/route.test.ts`) — sem os três,
 * o payload poderia sair certo e não chegar a lugar nenhum.
 */
describe("o recorte de encerrados antigos do quadro (#2995)", () => {
  const comRecorte = (settings: Record<string, unknown>): PipelineRow => ({
    id: "55555555-5555-4555-8555-555555555555",
    name: "Pedidos",
    slug: "pedidos",
    vocabulary: null,
    settings,
  });

  const caixa = () =>
    screen.getByRole("checkbox", { name: /Esconder do quadro os negócios encerrados/i });
  const campoDeDias = () =>
    screen.getByLabelText(/Dias de encerrado para esconder do quadro/i) as HTMLInputElement;
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

  it("relê o que está salvo: caixa marcada e os dias do settings", () => {
    render(
      <PipelinesClient pipelines={[comRecorte({ ocultar_encerrados_dias: 45 })]} podeEditarConfig />,
    );
    abrirEditores();

    expect(caixa()).toBeChecked();
    expect(campoDeDias()).toHaveValue(45);
  });

  it("funil sem a opção nasce DESMARCADO, com a sugestão no campo", () => {
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    expect(caixa()).not.toBeChecked();
    // A sugestão preenche o campo para ligar/desligar não exigir digitação — e
    // ela NÃO é gravada enquanto a caixa estiver desmarcada (caso abaixo).
    expect(campoDeDias()).toHaveValue(30);
  });

  it("salvar com a opção ligada manda os dias escolhidos", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    fireEvent.click(caixa());
    fireEvent.change(campoDeDias(), { target: { value: "15" } });
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updatePipelineConfig).mock.calls[0]?.[1].ocultar_encerrados_dias).toBe(15);
  });

  it("desligar manda 0 EXPLÍCITO — a chave não pode ficar com o número antigo", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(
      <PipelinesClient pipelines={[comRecorte({ ocultar_encerrados_dias: 45 })]} podeEditarConfig />,
    );
    abrirEditores();

    fireEvent.click(caixa());
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    // Um `undefined` aqui deixaria `45` no settings e os cards continuariam
    // sumindo do quadro de quem acabou de desligar a opção.
    expect(patch?.ocultar_encerrados_dias).toBe(0);
  });

  it("dias fora da faixa não salvam nada", () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    fireEvent.click(caixa());
    fireEvent.change(campoDeDias(), { target: { value: "0" } });
    salvar();

    // O schema recusaria o save inteiro com a mensagem genérica de validação;
    // barrar na tela é o que permite dizer QUAL campo está errado.
    expect(updatePipelineConfig).not.toHaveBeenCalled();
  });
});

describe("o vocabulário do funil fala português (doc 249, resposta B)", () => {
  // Os rótulos eram "Lead/Deal/Won/Lost" em inglês, e um funil sem vocabulário
  // gravado abria a caixa do card com "Deal". O card se chama "Negócio".
  const SEM_VOCABULARIO: PipelineRow = { ...FUNIL, vocabulary: null };

  it("os quatro rótulos estão em português, e nenhum em inglês", () => {
    render(<PipelinesClient pipelines={[SEM_VOCABULARIO]} etapas={{}} podeEditarConfig />);
    abrirEditores();
    for (const rotulo of ["Contato", "Negócio", "Ganho", "Perdido"]) {
      expect(screen.getByText(rotulo, { selector: "label" })).toBeInTheDocument();
    }
    for (const ingles of ["Lead", "Deal", "Won", "Lost"]) {
      expect(screen.queryByText(ingles, { selector: "label" })).toBeNull();
    }
  });

  it("sem vocabulário gravado, as caixas abrem e salvam os nomes neutros", () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[SEM_VOCABULARIO]} etapas={{}} podeEditarConfig />);
    abrirEditores();
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].vocabulary).toEqual({
      lead: "Contato",
      deal: "Negócio",
      won: "Ganho",
      lost: "Perdido",
    });
  });
});
