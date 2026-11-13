/**
 * Exportar → importar → igual, e as recusas do arquivo (`lib/automacoes/portabilidade.ts`).
 *
 * O cenário cobre o pedido do Filipe (13/11/2026): gatilho + mensagem + espera +
 * mover etapa, mais o que costuma carregar id de conta (canal no gatilho, pessoa,
 * "Iniciar a própria automação", chave secreta do HTTP, valor de condição
 * `lead.stage_id`).
 */
import { describe, expect, it } from "vitest";

import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";

import {
  FORMATO_DA_AUTOMACAO,
  REF_DESTA_AUTOMACAO,
  UUID_RX,
  ErroDeExportacao,
  exportarAutomacao,
  lerArquivoDeAutomacao,
  montarGrafoImportado,
  nomeDoArquivoDaAutomacao,
  previaDaImportacao,
  type CatalogoDaConta,
} from "./portabilidade";

const ORIGEM = {
  automacao: "aaaaaaaa-0000-4000-8000-000000000001",
  funil: "aaaaaaaa-0000-4000-8000-000000000010",
  etapaNova: "aaaaaaaa-0000-4000-8000-000000000011",
  etapaQualificado: "aaaaaaaa-0000-4000-8000-000000000012",
  pessoa: "aaaaaaaa-0000-4000-8000-000000000020",
  canal: "aaaaaaaa-0000-4000-8000-000000000030",
  chave: "aaaaaaaa-0000-4000-8000-000000000040",
};
const DESTINO = {
  automacao: "bbbbbbbb-0000-4000-8000-000000000001",
  funil: "bbbbbbbb-0000-4000-8000-000000000010",
  etapaNova: "bbbbbbbb-0000-4000-8000-000000000011",
  etapaQualificado: "bbbbbbbb-0000-4000-8000-000000000012",
  etapaOutroFunil: "bbbbbbbb-0000-4000-8000-000000000013",
  pessoa: "bbbbbbbb-0000-4000-8000-000000000020",
  canal: "bbbbbbbb-0000-4000-8000-000000000030",
  chave: "bbbbbbbb-0000-4000-8000-000000000040",
};

const CATALOGO_ORIGEM: CatalogoDaConta = [
  { id: ORIGEM.funil, tipo: "funil", nome: "Vendas", ativo: true },
  { id: ORIGEM.etapaNova, tipo: "etapa", nome: "Novo · Vendas", ativo: true },
  { id: ORIGEM.etapaQualificado, tipo: "etapa", nome: "Qualificado · Vendas", ativo: true },
  { id: ORIGEM.pessoa, tipo: "pessoa", nome: "Ingrid", ativo: true },
  { id: ORIGEM.canal, tipo: "canal", nome: "WhatsApp Comercial", ativo: true },
  { id: ORIGEM.chave, tipo: "segredo", nome: "Token do ERP", ativo: true },
  { id: ORIGEM.automacao, tipo: "automacao", nome: "Boas-vindas", ativo: true },
];
const CATALOGO_DESTINO: CatalogoDaConta = [
  { id: DESTINO.funil, tipo: "funil", nome: "vendas", ativo: true },
  { id: DESTINO.etapaNova, tipo: "etapa", nome: "Novo · Vendas", ativo: true },
  { id: DESTINO.etapaQualificado, tipo: "etapa", nome: "Qualificado · Vendas", ativo: true },
  { id: DESTINO.etapaOutroFunil, tipo: "etapa", nome: "Qualificado · Pós-venda", ativo: true },
  { id: DESTINO.pessoa, tipo: "pessoa", nome: "Ingrid", ativo: true },
  { id: DESTINO.canal, tipo: "canal", nome: "Outro número", ativo: true },
  { id: DESTINO.chave, tipo: "segredo", nome: "Token do ERP", ativo: true },
];

const pos = (y: number) => ({ x: 0, y });
const sempre = { type: "always" } as const;

function grafoDaOrigem(): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos(0),
        config: {
          triggers: [
            { kind: "stage_entered", stage_ids: [ORIGEM.etapaNova], via: "any" },
            { kind: "message_received", match: "any", keywords: [], channel_session_ids: [ORIGEM.canal] },
          ],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      {
        id: "n2",
        type: "message",
        label: "Boas-vindas",
        position: pos(200),
        config: { body: "Olá, {{contact.name}}!" },
      },
      {
        id: "n3",
        type: "wait",
        label: "Esperar 1 hora",
        position: pos(400),
        config: { mode: "fixed", duration_ms: 3_600_000 },
      },
      {
        id: "n4",
        type: "crm_action",
        label: "Mover e avisar",
        position: pos(600),
        config: {
          actions: [
            { type: "move_deal", pipeline_id: ORIGEM.funil, stage_id: ORIGEM.etapaQualificado },
            { type: "set_owner", mode: { m: "user", user_id: ORIGEM.pessoa } },
            { type: "start_automation", pointer_id: ORIGEM.automacao, params: [] },
          ],
          on_error: "continue",
        },
      },
      {
        id: "n5",
        type: "http_request",
        label: "Avisar o ERP",
        position: pos(800),
        config: {
          method: "POST",
          url: "https://erp.exemplo.com/v1",
          headers: [
            { kind: "chave", name: "X-Api-Key", secret_id: ORIGEM.chave, prefix: "" },
            { kind: "texto", name: "Authorization", value: "Bearer segredo-escrito-a-mao" },
            { kind: "texto", name: "X-Origem", value: "crm" },
          ],
          timeout_ms: 10_000,
          mappings: [],
        },
      },
      { id: "n6", type: "end", label: "Fim", position: pos(1000), config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
      { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
      { id: "e3", source: "n3", target: "n4", priority: 0, condition: sempre },
      { id: "e4", source: "n4", target: "n5", priority: 0, condition: sempre },
      { id: "e5", source: "n5", target: "n6", priority: 0, condition: sempre },
    ],
  });
}

const AGORA = new Date("2026-11-13T12:00:00Z");

function exportar() {
  return exportarAutomacao({ id: ORIGEM.automacao, nome: "Boas-vindas", grafo: grafoDaOrigem() }, CATALOGO_ORIGEM, AGORA);
}

/** Todo texto do valor (para procurar id que escapou). */
function textos(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textos);
  if (v && typeof v === "object") return Object.values(v).flatMap(textos);
  return [];
}

describe("exportar automação", () => {
  it("nenhum id da conta sai no arquivo: viram referências com tipo e nome", () => {
    const arquivo = exportar();
    expect(arquivo.formato).toBe(FORMATO_DA_AUTOMACAO);
    expect(textos(arquivo).filter((s) => UUID_RX.test(s))).toEqual([]);
    expect(arquivo.referencias).toEqual([
      { id: "etapa_1", tipo: "etapa", nome: "Novo · Vendas" },
      { id: "canal_1", tipo: "canal", nome: "WhatsApp Comercial" },
      { id: "funil_1", tipo: "funil", nome: "Vendas" },
      { id: "etapa_2", tipo: "etapa", nome: "Qualificado · Vendas" },
      { id: "pessoa_1", tipo: "pessoa", nome: "Ingrid" },
      { id: "segredo_1", tipo: "segredo", nome: "Token do ERP" },
    ]);
    // "Iniciar a própria automação" vira a referência reservada.
    expect(JSON.stringify(arquivo)).toContain(`"pointer_id":"${REF_DESTA_AUTOMACAO}"`);
  });

  it("nunca leva o valor escrito num cabeçalho de credencial; os outros cabeçalhos ficam", () => {
    const json = JSON.stringify(exportar());
    expect(json).not.toContain("segredo-escrito-a-mao");
    expect(json).toContain('"value":"crm"');
  });

  it("id que nem o catálogo nem o campo classificam recusa a exportação", () => {
    const g = grafoDaOrigem();
    const n2 = g.nodes.find((n) => n.id === "n2")!;
    (n2.config as { body: string }).body = "cccccccc-0000-4000-8000-000000000001";
    expect(() => exportarAutomacao({ id: ORIGEM.automacao, nome: "x", grafo: g }, CATALOGO_ORIGEM, AGORA)).toThrow(
      ErroDeExportacao,
    );
  });

  it("linha apagada na origem sai com o tipo do campo e nome vazio", () => {
    const sem = CATALOGO_ORIGEM.filter((i) => i.id !== ORIGEM.pessoa);
    const a = exportarAutomacao({ id: ORIGEM.automacao, nome: "x", grafo: grafoDaOrigem() }, sem, AGORA);
    expect(a.referencias).toContainEqual({ id: "pessoa_1", tipo: "pessoa", nome: null });
  });

  it("nome do arquivo sem acento nem símbolo", () => {
    expect(nomeDoArquivoDaAutomacao("Boas-vindas / Ação!")).toBe("boas-vindas-acao.automacao.json");
  });
});

describe("importar automação", () => {
  it("exporta → importa em outra conta → o mesmo grafo, com os ids de lá", () => {
    const leitura = lerArquivoDeAutomacao(JSON.parse(JSON.stringify(exportar())));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    const previa = previaDaImportacao(leitura.arquivo, leitura.usadas, CATALOGO_DESTINO);
    expect(previa.caixas).toBe(6);
    expect(previa.gatilhos).toEqual(["stage_entered", "message_received"]);
    const sugestoes = Object.fromEntries(previa.referencias.map((r) => [r.id, r.sugestao]));
    expect(sugestoes).toEqual({
      etapa_1: DESTINO.etapaNova,
      canal_1: null, // nome diferente: a pessoa escolhe
      funil_1: DESTINO.funil, // sem acento e sem caixa
      etapa_2: DESTINO.etapaQualificado, // «Etapa · Funil» exato, não a homônima do outro funil
      pessoa_1: DESTINO.pessoa,
      segredo_1: null, // chave secreta nunca é sugerida pelo nome
    });
    expect(previa.destinosHttp).toEqual([
      { caixa: "Avisar o ERP", metodo: "POST", url: "https://erp.exemplo.com/v1", chaves: ["segredo_1"] },
    ]);
    // As opções são só do tipo certo.
    expect(previa.referencias.find((r) => r.id === "canal_1")!.opcoes).toEqual([
      { id: DESTINO.canal, nome: "Outro número" },
    ]);

    const escolhas = { ...sugestoes, canal_1: DESTINO.canal, segredo_1: DESTINO.chave } as Record<string, string>;
    const m = montarGrafoImportado(leitura.arquivo, leitura.usadas, escolhas, CATALOGO_DESTINO, DESTINO.automacao);
    expect(m.ok).toBe(true);
    if (!m.ok) return;

    const troca = new Map<string, string>([
      [ORIGEM.funil, DESTINO.funil],
      [ORIGEM.etapaNova, DESTINO.etapaNova],
      [ORIGEM.etapaQualificado, DESTINO.etapaQualificado],
      [ORIGEM.pessoa, DESTINO.pessoa],
      [ORIGEM.canal, DESTINO.canal],
      [ORIGEM.chave, DESTINO.chave],
      [ORIGEM.automacao, DESTINO.automacao],
    ]);
    let esperado = JSON.stringify(grafoDaOrigem());
    for (const [de, para] of troca) esperado = esperado.split(de).join(para);
    const semSegredo = JSON.parse(esperado.replace("Bearer segredo-escrito-a-mao", "")) as unknown;
    expect(m.grafo).toEqual(flowGraphSchema.parse(semSegredo));
  });

  it("escolha de outro tipo, de outra conta ou ausente não monta nada", () => {
    const leitura = lerArquivoDeAutomacao(exportar());
    if (!leitura.ok) throw new Error("arquivo deveria ser válido");
    const base = {
      etapa_1: DESTINO.etapaNova,
      canal_1: DESTINO.canal,
      funil_1: DESTINO.funil,
      etapa_2: DESTINO.etapaQualificado,
      pessoa_1: DESTINO.pessoa,
      segredo_1: DESTINO.chave,
    };
    const casos: Array<[string, Record<string, string>]> = [
      ["pessoa no lugar da etapa", { ...base, etapa_1: DESTINO.pessoa }],
      ["id da conta de origem", { ...base, funil_1: ORIGEM.funil }],
      ["sem escolha", Object.fromEntries(Object.entries(base).filter(([k]) => k !== "segredo_1"))],
    ];
    for (const [nome, escolhas] of casos) {
      const m = montarGrafoImportado(leitura.arquivo, leitura.usadas, escolhas, CATALOGO_DESTINO, DESTINO.automacao);
      expect(m.ok, nome).toBe(false);
    }
  });

  it("linha inativa da conta não é opção nem escolha válida", () => {
    const leitura = lerArquivoDeAutomacao(exportar());
    if (!leitura.ok) throw new Error("arquivo deveria ser válido");
    const conta = CATALOGO_DESTINO.map((i) => (i.id === DESTINO.pessoa ? { ...i, ativo: false } : i));
    const previa = previaDaImportacao(leitura.arquivo, leitura.usadas, conta);
    expect(previa.referencias.find((r) => r.id === "pessoa_1")).toMatchObject({ sugestao: null, opcoes: [] });
  });

  describe("arquivo adulterado é recusado inteiro, com o caminho do problema", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- o teste adultera o arquivo em caminhos arbitrários
    const comoTexto = () => JSON.parse(JSON.stringify(exportar())) as Record<string, any>;

    it("formato errado", () => {
      const a = comoTexto();
      a.formato = "followup_flow";
      expect(lerArquivoDeAutomacao(a)).toMatchObject({ ok: false });
    });

    it("id cru de outra conta no grafo", () => {
      const a = comoTexto();
      a.automacao.grafo.nodes[3].config.actions[0].stage_id = ORIGEM.etapaQualificado;
      const r = lerArquivoDeAutomacao(a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problemas[0]).toContain("automacao.grafo.nodes.3.config.actions.0.stage_id");
    });

    it("referência que não está na lista", () => {
      const a = comoTexto();
      a.automacao.grafo.nodes[3].config.actions[0].stage_id = "ref:inventada";
      const r = lerArquivoDeAutomacao(a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problemas[0]).toContain('"ref:inventada"');
    });

    it("caixa quebrada (espera sem duração)", () => {
      const a = comoTexto();
      delete a.automacao.grafo.nodes[2].config.duration_ms;
      expect(lerArquivoDeAutomacao(a)).toMatchObject({ ok: false });
    });

    it("ligação para caixa que não existe", () => {
      const a = comoTexto();
      a.automacao.grafo.edges[0].target = "n99";
      expect(lerArquivoDeAutomacao(a)).toMatchObject({ ok: false });
    });

    it("fluxo de follow-up (sem os gatilhos de automação)", () => {
      const a = comoTexto();
      a.automacao.grafo.nodes[0].config = {};
      const r = lerArquivoDeAutomacao(a);
      expect(r.ok).toBe(false);
    });

    it("aninhamento fundo demais (estouro de pilha) vira problema, não erro", () => {
      const a = comoTexto();
      let fundo: unknown = "x";
      for (let i = 0; i < 5000; i++) fundo = [fundo];
      a.automacao.grafo.nodes[1].config.extra = fundo;
      const r = lerArquivoDeAutomacao(a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problemas[0]).toContain("aninhamento");
    });

    it("id de referência repetido", () => {
      const a = comoTexto();
      a.referencias.push({ ...a.referencias[0] });
      expect(lerArquivoDeAutomacao(a)).toMatchObject({ ok: false });
    });
  });

  it("arquivo escrito à mão (sem exportar) com referências por nome é aceito", () => {
    const aMao = {
      formato: "hiperbold-automacao",
      versao: 1,
      automacao: {
        nome: "Escrita à mão",
        grafo: {
          nodes: [
            {
              id: "n1",
              type: "trigger",
              label: "Início",
              position: pos(0),
              config: {
                triggers: [{ kind: "lead_created" }],
                reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
              },
            },
            {
              id: "n2",
              type: "crm_action",
              label: "Mover",
              position: pos(200),
              config: {
                actions: [{ type: "move_deal", pipeline_id: "ref:vendas", stage_id: "ref:qualificado" }],
                on_error: "continue",
              },
            },
            { id: "n3", type: "end", label: "Fim", position: pos(400), config: { outcome: "converted" } },
          ],
          edges: [
            { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
            { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
          ],
        },
      },
      referencias: [
        { id: "vendas", tipo: "funil", nome: "Vendas" },
        { id: "qualificado", tipo: "etapa", nome: "Qualificado · Vendas" },
      ],
    };
    const leitura = lerArquivoDeAutomacao(aMao);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const previa = previaDaImportacao(leitura.arquivo, leitura.usadas, CATALOGO_DESTINO);
    expect(previa.referencias.map((r) => r.sugestao)).toEqual([DESTINO.funil, DESTINO.etapaQualificado]);
  });
});
