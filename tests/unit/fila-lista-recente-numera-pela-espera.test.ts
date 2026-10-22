import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { comPosicaoNaFila, getQueuePosition, getQueuePositions } from "@/lib/routing/queue";

/**
 * A LISTA SAI DA MAIS RECENTE PARA A MAIS ANTIGA — E A POSIÇÃO CONTINUA SENDO A DA ESPERA.
 *
 * ─── A decisão (lote 2026-10-22) ─────────────────────────────────────────────
 * O dono do produto pediu todas as abas, a Fila inclusive, do mais recente para
 * o mais antigo. Até aqui a Fila ordenava por tempo de espera (`ORDEM_DA_ESPERA`,
 * quem espera há mais tempo no topo) e o "1º, 2º…" era o índice da linha.
 *
 * ─── O que este arquivo existe para impedir ──────────────────────────────────
 * Com a lista invertida, o índice da linha deixa de ser a ordem de atendimento.
 * Se o "1º" continuasse sendo o índice, o atendente leria como "atenda primeiro"
 * a conversa que ACABOU de chegar — e o número da tela divergiria do número que
 * o cliente ouve no WhatsApp, sem nada ficar vermelho. Por isso as duas metades
 * têm cerca: a lista pede atividade recente em TODAS as abas, e a posição sai de
 * `ORDEM_DA_ESPERA` (via `getQueuePositions`), nunca do índice.
 *
 * ─── A sabotagem, medida ─────────────────────────────────────────────────────
 * Voltar o handler para `ORDEM_DA_ESPERA` na Fila deixa o primeiro ⭐ vermelho;
 * trocar a ordem de `getQueuePositions` deixa o ⭐ das posições vermelho; e
 * `comPosicaoNaFila` numerando pelo índice da página deixa o caso da página
 * fora de ordem vermelho.
 */

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA — o mesmo padrão de `nao-lidos-filtra-no-banco`. */
function fakeSupabase(dados: unknown[] = []) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: dados, error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas;
}

/**
 * A ordem que o handler PEDIU ao banco, em texto — a asserção fica legível no
 * relatório e o `nullsFirst` não some no meio de um objeto comparado.
 */
function ordensPedidas(c: Chamada[]): string[] {
  return c
    .filter((x) => x.tabela === "conversations" && x.metodo === "order")
    .map((x) => {
      const [coluna, opcoes] = x.args as [
        string,
        { ascending?: boolean; nullsFirst?: boolean } | undefined,
      ];
      const direcao = opcoes?.ascending ? "crescente" : "decrescente";
      const nulos = opcoes?.nullsFirst ? "nulos-primeiro" : "nulos-por-último";
      return `${coluna} ${direcao} (${nulos})`;
    });
}

const ESPERA = [
  "awaiting_since crescente (nulos-por-último)",
  "id crescente (nulos-por-último)",
];

const ATIVIDADE = [
  "last_message_at decrescente (nulos-por-último)",
  "id decrescente (nulos-por-último)",
];

describe("toda aba pede ao banco a atividade mais recente primeiro", () => {
  it("⭐ a aba Fila: `last_message_at` decrescente, como as outras", async () => {
    const c = await listar({ comando: ["aguardando"] });
    expect(ordensPedidas(c)).toEqual(ATIVIDADE);
  });

  it("⭐ o caminho legado (`assigned_to=unassigned`) pede a MESMA ordem", async () => {
    // A Fila passou a se identificar por `comando`; o fallback ficou para as
    // chamadas antigas (MCP, link salvo). A mesma aba não pode dar duas ordens
    // conforme por onde entrou.
    const c = await listar({ assigned_to: "unassigned" });
    expect(ordensPedidas(c)).toEqual(ATIVIDADE);
  });

  it("Minhas, Todas, Fechadas e Automático: a mesma ordem", async () => {
    expect(ordensPedidas(await listar({}))).toEqual(ATIVIDADE);
    expect(ordensPedidas(await listar({ assigned_to: "me" }))).toEqual(ATIVIDADE);
    expect(ordensPedidas(await listar({ comando: ["humano"] }))).toEqual(ATIVIDADE);
    expect(ordensPedidas(await listar({ comando: ["automatico"] }))).toEqual(ATIVIDADE);
    expect(ordensPedidas(await listar({ status: ["closed"] }))).toEqual(ATIVIDADE);
  });

  it("⭐ o cursor do \"carregar mais\" anda na MESMA direção da ordem", async () => {
    // Ordem decrescente com cursor `gt` devolveria, na página 2, a página 1 de
    // novo. O cursor é base64 do JSON {sort, id} — o mesmo formato que o handler
    // emite (`encodeCursor`).
    const cursor = Buffer.from(
      JSON.stringify({ sort: "2026-10-20T10:00:00.000Z", id: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" }),
    ).toString("base64url");
    const c = await listar({ comando: ["aguardando"], cursor });
    const ors = c.filter((x) => x.metodo === "or").map((x) => String(x.args[0]));
    expect(ors.some((o) => o.startsWith("last_message_at.lt.") && o.includes("id.lt.9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"))).toBe(true);
  });

  it("⛔ a ordem sai na MESMA consulta que já filtra a organização", async () => {
    // Este handler usa o admin client, que passa por cima da RLS: o filtro manual
    // de organização é a ÚNICA barreira. Uma consulta nova "só para ordenar"
    // nasceria sem barreira nenhuma e devolveria conversa de OUTRO CLIENTE.
    const c = await listar({ comando: ["aguardando"] });
    expect(c.filter((x) => x.tabela === "conversations" && x.metodo === "eq").map((x) => x.args.join(":"))).toContain(
      "organization_id:org-1",
    );
    expect(c.filter((x) => x.metodo === "order").length).toBeGreaterThan(0);
  });
});

describe("a posição da linha é a ordem de ESPERA, não o índice da lista", () => {
  /**
   * O "3º" que o atendente lê na linha e o número que o cliente ouve no WhatsApp
   * são a MESMA conta: `ORDEM_DA_ESPERA` sobre a fila inteira. A lista agora sai
   * por atividade recente, então essa conta não pode ser o índice da página.
   */
  it("⭐ o mapa de posições pede a ordem da ESPERA", async () => {
    const { client, chamadas } = fakeSupabase();
    await getQueuePositions(client, "org-1");
    expect(ordensPedidas(chamadas)).toEqual(ESPERA);
  });

  it("⭐ o número que o cliente ouve conta pelo mesmo relógio", async () => {
    const { client, chamadas } = fakeSupabase();
    const entrada = "2026-09-16T12:00:00.000Z";
    await getQueuePosition(client, "org-1", entrada, new Date());
    const ltes = chamadas.filter((x) => x.metodo === "lte").map((x) => x.args.join(":"));
    expect(ltes).toContain(`awaiting_since:${entrada}`);
  });

  it("⭐ a página sai da mais recente para a mais antiga e cada linha leva a SUA posição na espera", async () => {
    // O banco devolve a fila na ordem da espera: a mais antiga primeiro.
    const { client } = fakeSupabase([{ id: "antiga" }, { id: "meio" }, { id: "nova" }]);
    // A página, na ordem da lista: a mais recente primeiro.
    const pagina = [{ id: "nova" }, { id: "meio" }, { id: "antiga" }];
    const comPosicao = await comPosicaoNaFila(client, "org-1", pagina);
    expect(comPosicao.map((c) => [c.id, c.queue_position])).toEqual([
      ["nova", 3],
      ["meio", 2],
      ["antiga", 1],
    ]);
  });

  it("⭐ \"carregar mais\": a posição é da fila inteira, não da página", async () => {
    // A página 2 traz só a mais antiga. Numerar pela página daria "1º" a ela por
    // acaso e "1º" de novo à primeira da página 1 — dois primeiros na mesma tela.
    const { client } = fakeSupabase([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    const pagina2 = [{ id: "b" }, { id: "a" }];
    const comPosicao = await comPosicaoNaFila(client, "org-1", pagina2);
    expect(comPosicao.map((c) => c.queue_position)).toEqual([2, 1]);
  });

  it("conversa que saiu da fila entre as duas leituras fica sem número, e não com o de outra", async () => {
    const { client } = fakeSupabase([{ id: "a" }]);
    const comPosicao = await comPosicaoNaFila(client, "org-1", [{ id: "x" }, { id: "a" }]);
    expect(comPosicao.map((c) => c.queue_position)).toEqual([null, 1]);
  });

  it("página vazia não consulta o banco", async () => {
    const { client, chamadas } = fakeSupabase([{ id: "a" }]);
    expect(await comPosicaoNaFila(client, "org-1", [])).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});

describe("a régua da ordem tem um lugar só", () => {
  const RAIZ = join(__dirname, "..", "..");
  const fonte = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8");

  it("⭐ as posições leem `ORDEM_DA_ESPERA` em vez de escrever a sua", () => {
    // A definição de QUEM está na fila já mora num lugar só (`comandosDaFila`,
    // vigiada por `fila-tem-uma-definicao-so`). A ORDEM DA ESPERA é a pergunta
    // vizinha: numera a linha e o que o cliente ouve, e tem um dono só.
    expect(fonte("lib/routing/queue.ts")).toContain("ORDEM_DA_ESPERA");
    // E a rota anexa a posição por esse dono, em vez de contar o índice.
    expect(fonte("app/api/v1/conversations/route.ts")).toContain("comPosicaoNaFila");
  });

  it("⭐ o PREDICADO da Fila também vem de um lugar só", () => {
    // O predicado que decide "isto é a Fila" vale em dois lugares: a rota (que
    // anexa a posição na espera) e a lista (que mostra "1º, 2º…" e o tempo de
    // espera). Ganhar uma condição num só dos dois
    // produz a linha com espera e sem número (ou o contrário) — sem nada
    // ficar vermelho, que é exatamente o modo de falha que este arquivo vigia.
    const PROIBIDO = /includes\(\s*["']aguardando["']\s*\)/;
    // Controle: a régua morde quando o literal existe.
    expect(PROIBIDO.test('filters.comando?.includes("aguardando")')).toBe(true);

    for (const caminho of [
      "app/api/v1/conversations/route.ts",
      "components/inbox/ConversationList.tsx",
    ]) {
      const semComentarios = fonte(caminho)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(semComentarios, `${caminho}: o predicado da Fila voltou a ser escrito à mão`).not.toMatch(
        PROIBIDO,
      );
      expect(fonte(caminho), `${caminho}: não usa ehAFila`).toContain("ehAFila");
    }
  });

  it("⛔ o literal não voltou como régua própria — e a cerca morde", () => {
    const PROIBIDO = /\.order\(\s*["']last_inbound_at["']/;
    // O controle: uma varredura que nasce com zero achados pode estar certa ou
    // cega, e as duas se leem igual.
    expect(PROIBIDO.test('.order("last_inbound_at", { ascending: true })')).toBe(true);

    for (const caminho of ["app/api/v1/conversations/_handler.ts", "lib/routing/queue.ts"]) {
      const semComentarios = fonte(caminho)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(semComentarios, `${caminho}: ordem da espera escrita à mão`).not.toMatch(PROIBIDO);
    }
  });
});
