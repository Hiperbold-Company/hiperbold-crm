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
  meta_social_envios: [["organization_id", "mid"]],
  meta_social_comentarios: [["organization_id", "comment_id"]],
  meta_social_fila_de_envio: [["organization_id", "tipo", "comment_id"]],
};

/** Defaults de coluna que o comportamento testado lê. */
const PADROES: Record<string, Linha> = {
  meta_data_deletion_requests: { status: "received", completed_at: null },
  meta_social_comentarios: { resposta_privada_status: "nao_pedida" },
  meta_social_fila_de_envio: { status: "na_fila", tentativas: 0 },
};

/** Índices únicos PARCIAIS: só valem entre as linhas que o predicado aceita. */
const UNICOS_PARCIAIS: Record<string, { cols: string[]; onde: (l: Linha) => boolean }[]> = {
  meta_data_deletion_requests: [{ cols: ["platform", "meta_user_id"], onde: (l) => (l.status ?? "received") === "received" }],
};

/** `metadata->>chave` lê a chave do jsonb, como o PostgREST. */
function valor(l: Linha, c: string): unknown {
  const m = /^([a-z_]+)->>([a-z_]+)$/.exec(c);
  if (!m) return l[c];
  const o = l[m[1]!] as Record<string, unknown> | null | undefined;
  const v = o?.[m[2]!];
  return v === undefined || v === null ? null : String(v);
}

export function bancoFalso(inicial: Record<string, Linha[]> = {}) {
  const tabelas: Record<string, Linha[]> = {};
  for (const [k, v] of Object.entries(inicial)) tabelas[k] = v.map((l) => ({ ...l }));
  const t = (nome: string) => (tabelas[nome] ??= []);

  function consulta(nome: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
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
      delete() {
        op = "delete";
        return q;
      },
      eq(c: string, v: unknown) {
        filtros.push((l) => valor(l, c) === v);
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
      gte(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) >= v);
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
          const novas: Linha[] = (Array.isArray(carga) ? carga : [carga!]).map((l) => ({
            id: randomUUID(),
            ...(PADROES[nome] ?? {}),
            ...l,
          }));
          for (const n of novas) {
            for (const cols of UNICOS[nome] ?? []) {
              if (cols.some((c) => n[c] == null)) continue;
              if (linhas.some((l) => cols.every((c) => l[c] === n[c])))
                return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            for (const { cols, onde } of UNICOS_PARCIAIS[nome] ?? []) {
              if (!onde(n)) continue;
              if (linhas.some((l) => onde(l) && cols.every((c) => l[c] === n[c])))
                return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
          }
          linhas.push(...novas);
          return { data: novas, error: null };
        }
        let alvo = linhas.filter((l) => filtros.every((f) => f(l)));
        if (op === "delete") {
          for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
          return { data: retornar ? alvo : null, error: null };
        }
        if (op === "update") {
          for (const l of alvo) Object.assign(l, carga);
          return { data: retornar ? alvo : null, error: null };
        }
        if (ordem) {
          const { col, asc } = ordem;
          alvo = [...alvo].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        // Cópias, como o PostgREST: quem leu não segura a linha viva do banco.
        return { data: alvo.slice(0, limite).map((l) => ({ ...l })), error: null };
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
    if (nome === "fn_meta_social_registrar_comentario") {
      // O que a função da 0991 faz (provado contra o Postgres em
      // tests/invariants/instagram-comentarios.test.ts): sessão da organização,
      // linha única por (organização, comentário) e um evento só na primeira vez.
      const sessao = t("channel_sessions").find(
        (s) => s.id === args.p_channel_session_id && s.organization_id === args.p_organization_id,
      );
      if (!sessao) return { data: null, error: { code: "42501", message: "meta_social_sessao_de_outra_organizacao" } };
      if (
        t("meta_social_comentarios").some(
          (c) => c.organization_id === args.p_organization_id && c.comment_id === args.p_comment_id,
        )
      )
        return { data: null, error: null };
      const id = randomUUID();
      const recebido = new Date().toISOString();
      t("meta_social_comentarios").push({
        id,
        organization_id: args.p_organization_id,
        channel_session_id: args.p_channel_session_id,
        comment_id: args.p_comment_id,
        media_id: args.p_media_id,
        media_product_type: args.p_media_product_type,
        autor_id: args.p_autor_id,
        autor_usuario: args.p_autor_usuario,
        texto: args.p_texto,
        criado_na_meta_em: args.p_criado_na_meta_em,
        recebido_em: recebido,
        resposta_privada_status: "nao_pedida",
      });
      t("event_log").push({
        organization_id: args.p_organization_id,
        event_type: "instagram.comentario_recebido",
        entity_kind: "instagram_comment",
        entity_id: id,
        payload: { comentario_id: id, comment_id: args.p_comment_id, autor_id: args.p_autor_id },
      });
      return { data: id, error: null };
    }
    if (nome === "emit_event") {
      // O que importa do `emit_event` do baseline para o canal: uma linha no
      // `event_log` com tipo, entidade e payload como vieram.
      t("event_log").push({
        id: randomUUID(),
        organization_id: args.p_organization_id,
        event_type: args.p_event_type,
        entity_kind: args.p_entity_kind,
        entity_id: args.p_entity_id,
        payload: args.p_payload,
        metadata: args.p_metadata,
      });
      return { data: null, error: null };
    }
    if (nome === "fn_encrypt_oauth") return { data: `cifrado:${String(args.plaintext)}`, error: null };
    return { data: null, error: null };
  };

  const db = { from: (nome: string) => consulta(nome), rpc } as unknown as SupabaseClient;
  return { db, tabelas, t };
}
