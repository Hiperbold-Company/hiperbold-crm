/**
 * Um "Supabase" em memória para as rotas de itens do negócio (`/api/v1/leads/:id/itens`).
 *
 * NÃO mocka o código testado: é o banco que a rota consulta, e ele APLICA os
 * filtros de verdade (`eq`) em select, update e delete. Uma consulta que esquece
 * `organization_id` enxerga a outra organização aqui — é assim que o teste de
 * isolamento prova que a rota filtra, e não que o mock devolve vazio.
 *
 * O que ele NÃO faz: RLS e gatilhos. A soma do valor do negócio e a visibilidade
 * por papel são provadas no Postgres real, em
 * `tests/invariants/produtos-no-negocio.test.ts`.
 */
type Linha = Record<string, unknown>;

export interface BancoDeItens {
  tabelas: Record<string, Linha[]>;
  /** Tudo que foi inserido, por tabela, na ordem — para provar o que a rota gravou. */
  inseridos: Record<string, Linha[]>;
}

export function criarBancoDeItens(tabelas: Record<string, Linha[]>): BancoDeItens {
  return { tabelas: structuredClone(tabelas), inseridos: {} };
}

let sequencia = 0;
const novoId = () => `aaaaaaaa-0000-4000-8000-${String(++sequencia).padStart(12, "0")}`;

export function clienteDeItens(banco: BancoDeItens): never {
  return {
    from(nome: string) {
      const linhas = (banco.tabelas[nome] ??= []);
      const filtros: Array<[string, unknown]> = [];
      let operacao: "select" | "insert" | "update" | "delete" = "select";
      let payload: Linha = {};
      let contagem = false;

      const casam = () => linhas.filter((l) => filtros.every(([c, v]) => l[c] === v));

      const executar = (modo: "lista" | "unica"): { data: unknown; error: null; count?: number } => {
        if (operacao === "insert") {
          const nova: Linha = { id: novoId(), created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", ...payload };
          linhas.push(nova);
          (banco.inseridos[nome] ??= []).push(nova);
          return { data: modo === "unica" ? nova : [nova], error: null };
        }
        const alvo = casam();
        if (operacao === "update") {
          for (const l of alvo) Object.assign(l, payload);
        }
        if (operacao === "delete") {
          for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
        }
        if (modo === "unica") return { data: alvo[0] ?? null, error: null };
        return { data: alvo, error: null, ...(contagem ? { count: alvo.length } : {}) };
      };

      const construtor = {
        select(_colunas?: string, opcoes?: { count?: string; head?: boolean }) {
          if (opcoes?.count) contagem = true;
          return construtor;
        },
        insert(linha: Linha) {
          operacao = "insert";
          payload = linha;
          return construtor;
        },
        update(valores: Linha) {
          operacao = "update";
          payload = valores;
          return construtor;
        },
        delete() {
          operacao = "delete";
          return construtor;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push([coluna, valor]);
          return construtor;
        },
        order() {
          return construtor;
        },
        limit() {
          return construtor;
        },
        maybeSingle: async () => executar("unica"),
        single: async () => {
          const r = executar("unica");
          return r.data === null ? { data: null, error: { code: "PGRST116", message: "sem linha" } } : r;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(executar("lista")).then(resolve);
        },
      };
      return construtor;
    },
    rpc: async () => ({ data: null, error: null }),
  } as never;
}
