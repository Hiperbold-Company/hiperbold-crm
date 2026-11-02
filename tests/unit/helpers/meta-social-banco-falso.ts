/**
 * Banco em memória mínimo para os testes do canal social oficial: o bastante
 * do PostgREST (select/insert/update com eq/is/not/in/order/limit,
 * maybeSingle/single) e as duas restrições únicas que o comportamento testado
 * depende (`messages (organization_id, external_id)` e
 * `contacts (organization_id, social_identity)`), que devolvem 23505 como o
 * Postgres. Não é mock do código testado: é o lugar onde ele escreve.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Linha = Record<string, unknown>;

const UNICOS: Record<string, string[][]> = {
  messages: [["organization_id", "external_id"]],
  contacts: [["organization_id", "social_identity"]],
  calendar_oauth_nonces: [["nonce"]],
};

export function bancoFalso(inicial: Record<string, Linha[]> = {}) {
  const tabelas: Record<string, Linha[]> = {};
  for (const [k, v] of Object.entries(inicial)) tabelas[k] = v.map((l) => ({ ...l }));
  const t = (nome: string) => (tabelas[nome] ??= []);

  function consulta(nome: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    let op: "select" | "insert" | "update" = "select";
    let carga: Linha | Linha[] | null = null;
    let limite = Infinity;
    let ordem: { col: string; asc: boolean } | null = null;
    let retornar = false;
    const q = {
      select() {
        if (op !== "select") retornar = true;
        return q;
      },
      insert(v: Linha | Linha[]) {
        op = "insert";
        carga = v;
        return q;
      },
      update(v: Linha) {
        op = "update";
        carga = v;
        return q;
      },
      eq(c: string, v: unknown) {
        filtros.push((l) => l[c] === v);
        return q;
      },
      neq(c: string, v: unknown) {
        filtros.push((l) => l[c] !== v);
        return q;
      },
      is(c: string, v: unknown) {
        filtros.push((l) => (l[c] ?? null) === v);
        return q;
      },
      not(c: string, opr: string, v: unknown) {
        if (opr === "is") filtros.push((l) => (l[c] ?? null) !== v);
        else if (opr === "in") {
          const lista = String(v).replace(/[()]/g, "").split(",");
          filtros.push((l) => !lista.includes(String(l[c])));
        }
        return q;
      },
      in(c: string, v: unknown[]) {
        filtros.push((l) => v.includes(l[c]));
        return q;
      },
      gt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) > v);
        return q;
      },
      lt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) < v);
        return q;
      },
      lte(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) <= v);
        return q;
      },
      order(col: string, o?: { ascending?: boolean }) {
        ordem = { col, asc: o?.ascending !== false };
        return q;
      },
      limit(n: number) {
        limite = n;
        return q;
      },
      executar(): { data: unknown; error: { code: string; message: string } | null } {
        const linhas = t(nome);
        if (op === "insert") {
          const novas: Linha[] = (Array.isArray(carga) ? carga : [carga!]).map((l) => ({ id: randomUUID(), ...l }));
          for (const n of novas) {
            for (const cols of UNICOS[nome] ?? []) {
              if (cols.some((c) => n[c] == null)) continue;
              if (linhas.some((l) => cols.every((c) => l[c] === n[c])))
                return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
          }
          linhas.push(...novas);
          return { data: novas, error: null };
        }
        let alvo = linhas.filter((l) => filtros.every((f) => f(l)));
        if (op === "update") {
          for (const l of alvo) Object.assign(l, carga);
          return { data: retornar ? alvo : null, error: null };
        }
        if (ordem) {
          const { col, asc } = ordem;
          alvo = [...alvo].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return { data: alvo.slice(0, limite), error: null };
      },
      maybeSingle() {
        const r = q.executar();
        const d = r.data as Linha[] | null;
        return Promise.resolve({ data: Array.isArray(d) ? (d[0] ?? null) : d, error: r.error });
      },
      single() {
        return q.maybeSingle();
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(q.executar()).then(res, rej);
      },
    };
    return q;
  }

  const rpc = async (nome: string, args: Record<string, unknown>) => {
    if (nome === "fn_upsert_wa_conversation") {
      const existente = t("conversations").find(
        (c) =>
          c.organization_id === args.p_org &&
          c.contact_id === args.p_contact &&
          c.channel_session_id === args.p_session,
      );
      if (existente) return { data: existente.id, error: null };
      const id = randomUUID();
      t("conversations").push({
        id,
        organization_id: args.p_org,
        contact_id: args.p_contact,
        channel_session_id: args.p_session,
        channel: "whatsapp",
      });
      return { data: id, error: null };
    }
    if (nome === "fn_decrypt_oauth") {
      return { data: String(args.ciphertext).replace(/^\\x/, "").replace(/^cifrado:/, ""), error: null };
    }
    if (nome === "fn_encrypt_oauth") return { data: `cifrado:${String(args.plaintext)}`, error: null };
    return { data: null, error: null };
  };

  const db = { from: (nome: string) => consulta(nome), rpc } as unknown as SupabaseClient;
  return { db, tabelas, t };
}
