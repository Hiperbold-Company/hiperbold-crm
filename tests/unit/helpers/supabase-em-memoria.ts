/**
 * Um cliente "Supabase" em memória, só com o que a lista, a contagem, a exclusão em lote e a
 * exportação de contatos usam. NÃO mocka o código testado — é o banco que ele consulta, e ele
 * APLICA os filtros de verdade: uma consulta sem `organization_id` enxerga as duas organizações,
 * e uma junção com dois predicados exige os dois NO MESMO negócio.
 *
 * Imita o PostgREST no que importa para os filtros:
 *  - `ilike` com `%`, `_` e `\` (escape); `*` vira `%` ANTES de casar (é assim no PostgREST, e é
 *    o que `consulta.ts` precisa neutralizar);
 *  - caminho JSON `custom_fields->>chave`;
 *  - `or("coluna.ilike.valor,coluna.eq.valor")`, com valor entre aspas (`"a,b"`, `\"` e `\\`
 *    escapados) e `apelido.not.is.null` (a junção opcional achou algum registro);
 *  - junção `apelido:tabela!fk!inner(id)` + predicados `apelido.coluna`: o contato passa se ALGUM
 *    registro da tabela ligada satisfaz TODOS os predicados daquele apelido;
 *  - junção SEM `!inner` (`apelido:tabela!fk(id)`): não corta o contato; só responde ao
 *    `apelido.not.is.null` do `or`. Cada apelido tem os PRÓPRIOS predicados.
 *
 * Que estas regras são as do PostgREST de verdade foi medido contra um PostgREST real (v16.2) em
 * 28/10/2026, com os mesmos casos de "qualquer" de `contatos-lote-e-exportacao.test.ts`.
 *
 * `fn_excluir_contatos_em_lote` é reimplementada aqui com a mesma regra da migration 0971 — a prova
 * do SQL de verdade é `tests/invariants/excluir-contatos-em-lote.test.ts` (Postgres real).
 */
type Linha = Record<string, unknown>;

export interface BancoEmMemoria {
  tabelas: Record<string, Linha[]>;
  chamadasRpc: Array<{ nome: string; args: Record<string, unknown> }>;
  /** Consultas executadas: tabela, operação e filtros — para provar o que foi (ou não foi) filtrado. */
  consultas: Array<{ tabela: string; operacao: "select" | "delete"; filtros: Array<[string, string, unknown]> }>;
  /** Faz o DELETE da tabela falhar com este erro. */
  falhaNoDelete?: { tabela: string; erro: { code: string; message: string } };
  /** Faz a N-ésima chamada (1 = primeira) de `fn_excluir_contatos_em_lote` falhar, sem apagar nada do bloco (transação). */
  falhaNaExclusaoDoBloco?: number;
}

export function criarBanco(tabelas: Record<string, Linha[]>): BancoEmMemoria {
  return { tabelas: structuredClone(tabelas), chamadasRpc: [], consultas: [] };
}

const valorDe = (linha: Linha, coluna: string): unknown => {
  const [base, chave] = coluna.split("->>");
  const v = linha[base!];
  if (chave === undefined) return v;
  return v && typeof v === "object" ? (v as Record<string, unknown>)[chave] : undefined;
};

/** LIKE do Postgres, sem diferenciar maiúsculas; `*` vira `%` antes (como o PostgREST). */
function ilikeCasa(valor: unknown, padrao: string): boolean {
  if (valor === null || valor === undefined) return false;
  let re = "";
  const p = padrao.replace(/(?<!\\)\*/g, "%");
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\" && i + 1 < p.length) {
      re += p[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(String(valor));
}

/** Quebra o `or` nas vírgulas de fora das aspas. */
function partesDoOr(expr: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (aspas && c === "\\") {
      atual += c + (expr[++i] ?? "");
    } else if (c === '"') {
      aspas = !aspas;
      atual += c;
    } else if (c === "," && !aspas) {
      partes.push(atual);
      atual = "";
    } else atual += c;
  }
  partes.push(atual);
  return partes;
}

/** Valor entre aspas do `or`: tira as aspas e desfaz `\"` e `\\`. */
function valorDoOr(v: string): string {
  if (!(v.startsWith('"') && v.endsWith('"') && v.length >= 2)) return v;
  return v.slice(1, -1).replace(/\\(.)/g, "$1");
}

export function clienteEmMemoria(banco: BancoEmMemoria): never {
  let chamadasDaExclusao = 0;

  const cliente = {
    from(tabela: string) {
      const filtros: Array<[string, string, unknown]> = [];
      const predicados: Array<(l: Linha) => boolean> = [];
      const juncoes = new Map<string, { tabela: string; inner: boolean; predicados: Array<(l: Linha) => boolean> }>();
      let operacao: "select" | "delete" = "select";
      let opcoes: { count?: string; head?: boolean } | undefined;
      let ordem: { col: string; asc: boolean } | undefined;
      let faixa: [number, number] | undefined;

      const adicionar = (coluna: string, fn: (v: unknown) => boolean) => {
        const apelido = [...juncoes.keys()].find((a) => coluna.startsWith(`${a}.`));
        const nome = apelido ? coluna.slice(apelido.length + 1) : coluna;
        (apelido ? juncoes.get(apelido)!.predicados : predicados).push((l) => fn(valorDe(l, nome)));
      };

      /** A junção achou algum registro ligado que satisfaz todos os predicados dela? */
      const juncaoAchou = (apelido: string, linha: Linha): boolean => {
        const j = juncoes.get(apelido);
        if (!j) throw new Error(`junção ${apelido} não declarada no select`);
        const ligadas = banco.tabelas[j.tabela] ?? [];
        return ligadas.some((n) => n.contact_id === linha.id && j.predicados.every((p) => p(n)));
      };

      const casa = (linha: Linha): boolean => {
        if (!predicados.every((p) => p(linha))) return false;
        for (const [apelido, j] of juncoes) if (j.inner && !juncaoAchou(apelido, linha)) return false;
        return true;
      };

      const executar = () => {
        banco.consultas.push({ tabela, operacao, filtros: [...filtros] });
        const todas = banco.tabelas[tabela] ?? [];
        if (operacao === "delete") {
          if (banco.falhaNoDelete?.tabela === tabela) {
            return { data: null, error: banco.falhaNoDelete.erro, count: null };
          }
          const removidas = todas.filter(casa);
          banco.tabelas[tabela] = todas.filter((l) => !casa(l));
          return { data: removidas.map((l) => ({ ...l })), error: null, count: null };
        }
        let achadas = todas.filter(casa);
        if (ordem) {
          const { col, asc } = ordem;
          achadas = [...achadas].sort((a, b) =>
            String(a[col] ?? "") < String(b[col] ?? "") ? (asc ? -1 : 1) : asc ? 1 : -1,
          );
        }
        const total = achadas.length;
        if (faixa) achadas = achadas.slice(faixa[0], faixa[1] + 1);
        return {
          data: opcoes?.head ? null : achadas.map((l) => ({ ...l })),
          error: null,
          count: opcoes?.count ? total : null,
        };
      };

      const cadeia: Record<string, unknown> = {
        select(colunas?: string, o?: { count?: string; head?: boolean }) {
          if (o) opcoes = o;
          for (const m of (colunas ?? "").matchAll(/(\w+):(\w+)!\w+(!inner)?\(/g)) {
            juncoes.set(m[1]!, { tabela: m[2]!, inner: Boolean(m[3]), predicados: [] });
          }
          return cadeia;
        },
        delete() {
          operacao = "delete";
          return cadeia;
        },
        eq(col: string, val: unknown) {
          filtros.push(["eq", col, val]);
          adicionar(col, (v) => v === val);
          return cadeia;
        },
        in(col: string, val: unknown[]) {
          filtros.push(["in", col, val]);
          adicionar(col, (v) => val.includes(v));
          return cadeia;
        },
        is(col: string, val: unknown) {
          filtros.push(["is", col, val]);
          adicionar(col, (v) => (v ?? null) === val);
          return cadeia;
        },
        ilike(col: string, padrao: string) {
          filtros.push(["ilike", col, padrao]);
          adicionar(col, (v) => ilikeCasa(v, padrao));
          return cadeia;
        },
        contains(col: string, arr: unknown[]) {
          filtros.push(["contains", col, arr]);
          adicionar(col, (v) => Array.isArray(v) && arr.every((x) => v.includes(x)));
          return cadeia;
        },
        gte(col: string, val: string) {
          filtros.push(["gte", col, val]);
          adicionar(col, (v) => v != null && new Date(String(v)).getTime() >= new Date(val).getTime());
          return cadeia;
        },
        lt(col: string, val: string) {
          filtros.push(["lt", col, val]);
          adicionar(col, (v) => v != null && new Date(String(v)).getTime() < new Date(val).getTime());
          return cadeia;
        },
        or(expr: string) {
          filtros.push(["or", "", expr]);
          const partes = partesDoOr(expr).map((p) => {
            const [col, op, ...resto] = p.split(".");
            return { col: col!, op: op!, val: valorDoOr(resto.join(".")) };
          });
          predicados.push((l) =>
            partes.some(({ col, op, val }) =>
              op === "ilike"
                ? ilikeCasa(valorDe(l, col), val)
                : op === "eq"
                  ? String(valorDe(l, col)) === val
                  : op === "not" && val === "is.null"
                    ? juncaoAchou(col, l)
                    : false,
            ),
          );
          return cadeia;
        },
        order(col: string, o?: { ascending?: boolean }) {
          ordem = { col, asc: o?.ascending !== false };
          return cadeia;
        },
        range(de: number, ate: number) {
          faixa = [de, ate];
          return cadeia;
        },
        limit() {
          return cadeia;
        },
        then(resolve: (v: unknown) => unknown, rejeitar?: (e: unknown) => unknown) {
          return Promise.resolve(executar()).then(resolve, rejeitar);
        },
      };
      return cadeia;
    },

    rpc(nome: string, args: Record<string, unknown>) {
      banco.chamadasRpc.push({ nome, args });
      if (nome !== "fn_excluir_contatos_em_lote") return Promise.resolve({ data: null, error: null });

      // Mesma regra da migration 0971, tudo-ou-nada.
      chamadasDaExclusao += 1;
      if (banco.falhaNaExclusaoDoBloco === chamadasDaExclusao) {
        return Promise.resolve({ data: null, error: { code: "P0001", message: "lote_nao_apagou_tudo" } });
      }
      const org = args.p_organization_id as string;
      const pedidos = args.p_contact_ids as string[];
      if (pedidos.length > 100) {
        return Promise.resolve({ data: null, error: { code: "22023", message: "lote_grande_demais" } });
      }
      const agenda = banco.tabelas.calendar_appointments ?? [];
      const alvo = (banco.tabelas.contacts ?? [])
        .filter(
          (c) =>
            c.organization_id === org &&
            pedidos.includes(c.id as string) &&
            !c.is_merged_into &&
            !c.is_anonymized &&
            !agenda.some((a) => a.contact_id === c.id && a.organization_id === org),
        )
        .map((c) => c.id as string);
      for (const tabela of ["messages", "conversations"]) {
        banco.tabelas[tabela] = (banco.tabelas[tabela] ?? []).filter(
          (l) => !(l.organization_id === org && alvo.includes(l.contact_id as string)),
        );
      }
      banco.tabelas.contacts = (banco.tabelas.contacts ?? []).filter(
        (c) => !(c.organization_id === org && alvo.includes(c.id as string)),
      );
      return Promise.resolve({ data: alvo, error: null });
    },
  };
  return cliente as never;
}
