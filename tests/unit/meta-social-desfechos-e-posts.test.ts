/**
 * Canal oficial do Instagram, três peças que as automações consomem:
 *  1. os eventos de desfecho da fila de respostas (`instagram.resposta_enviada`
 *     e `instagram.resposta_falhou`), com o payload exato e o `pedido_por`
 *     devolvido como foi gravado;
 *  2. a `plataforma` de cada conexão na listagem de canais;
 *  3. os posts da conta (lista e resolução por link).
 *
 * O banco é o em memória dos testes do canal (o lugar onde o código escreve);
 * a Meta é um `fetch` falso que registra o que recebeu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

import {
  CAMPOS_DO_EVENTO_DESFECHO,
  ENTIDADE_DO_EVENTO_RESPOSTA,
  EVENTO_RESPOSTA_ENVIADA,
  EVENTO_RESPOSTA_FALHOU,
} from "@/lib/channels/meta-social/comentarios-contrato";
import { processarFilaMetaSocial } from "@/lib/channels/meta-social/fila";
import { codigoDoLink, listarPostsRecentes, resolverPostPorLink } from "@/lib/channels/meta-social/posts";
import { listarConexoesDeMensagem, plataformaDaConexao } from "@/lib/channels/listar-conexoes";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IG = "17841400000000001";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const PEDIDO = "automacao:ptr-1:enr-2:passo-3";

const sessaoA = {
  id: "sessao-a",
  organization_id: ORG_A,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: IG,
  meta_social_page_id: "PAG-1",
  meta_social_token_encrypted: "cifrado:TOKEN-DA-PAGINA",
  archived_at: null,
  status: "WORKING",
  status_reason: null,
};

const comentario = (commentId: string, extra: Record<string, unknown> = {}) => ({
  id: `linha-${commentId}`,
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  comment_id: commentId,
  autor_id: "IGSID-1",
  texto: "quero o link",
  criado_na_meta_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  recebido_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  resposta_privada_status: "na_fila",
  ...extra,
});

const naFila = (commentId: string, tipo: "resposta_privada" | "resposta_publica", extra: Record<string, unknown> = {}) => ({
  id: `fila-${tipo}-${commentId}`,
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  tipo,
  comment_id: commentId,
  texto: "Te mandei no Direct!",
  pedido_por: PEDIDO,
  status: "na_fila",
  tentativas: 0,
  proxima_tentativa_em: new Date(AGORA.getTime() - 1000).toISOString(),
  criado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  atualizado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  ...extra,
});

function metaFalsa(responder: (url: string) => { status: number; corpo: unknown }) {
  const chamadas: { url: string; auth: string | undefined; method: string | undefined }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    chamadas.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization, method: init?.method });
    const r = responder(u);
    return new Response(JSON.stringify(r.corpo), { status: r.status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, chamadas };
}

const okMeta = () =>
  metaFalsa((url) =>
    url.endsWith("/replies") ? { status: 200, corpo: { id: "reply-1" } } : { status: 200, corpo: { message_id: "mid.priv" } },
  );
const erroMeta = (status: number, code: number) => metaFalsa(() => ({ status, corpo: { error: { code, message: "x" } } }));

const eventos = (banco: ReturnType<typeof bancoFalso>) => banco.t("event_log");

// ─── 1. Eventos de desfecho ─────────────────────────────────────────────────

describe("fila: eventos de desfecho", () => {
  it("enviada emite instagram.resposta_enviada com o payload exato, sem texto", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    await processarFilaMetaSocial(banco.db, AGORA, okMeta().fetcher);
    expect(eventos(banco)).toHaveLength(1);
    const e = eventos(banco)[0]!;
    expect(e).toMatchObject({
      organization_id: ORG_A,
      event_type: EVENTO_RESPOSTA_ENVIADA,
      entity_kind: ENTIDADE_DO_EVENTO_RESPOSTA,
      entity_id: "fila-resposta_privada-C-1",
    });
    expect(e.payload).toEqual({
      organization_id: ORG_A,
      channel_session_id: "sessao-a",
      comment_id: "C-1",
      tipo: "resposta_privada",
      pedido_por: PEDIDO,
    });
    expect(JSON.stringify(e.payload)).not.toContain("Direct");
    expect(JSON.stringify(e.payload)).not.toContain("quero");
    for (const k of Object.keys(e.payload as object)) expect(CAMPOS_DO_EVENTO_DESFECHO).toContain(k);
  });

  it("pedido_por volta EXATAMENTE como foi gravado, e null quando não há", async () => {
    const longo = `automacao:${"p".repeat(60)}:${"e".repeat(60)}:${"s".repeat(60)}`;
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1"), comentario("C-2")],
      meta_social_fila_de_envio: [
        naFila("C-1", "resposta_publica", { pedido_por: longo }),
        naFila("C-2", "resposta_publica", { pedido_por: null }),
      ],
    });
    await processarFilaMetaSocial(banco.db, AGORA, okMeta().fetcher);
    const porComentario = Object.fromEntries(
      eventos(banco).map((e) => [(e.payload as { comment_id: string }).comment_id, e.payload as Record<string, unknown>]),
    );
    expect(porComentario["C-1"]!.pedido_por).toBe(longo);
    expect(porComentario["C-1"]!.tipo).toBe("resposta_publica");
    expect(porComentario["C-2"]!.pedido_por).toBeNull();
  });

  it("erro final da Meta emite instagram.resposta_falhou com o código gravado em `erro`", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    await processarFilaMetaSocial(banco.db, AGORA, erroMeta(400, 100).fetcher);
    const linha = banco.t("meta_social_fila_de_envio")[0]!;
    expect(linha.status).toBe("falhou");
    expect(eventos(banco)).toHaveLength(1);
    expect(eventos(banco)[0]).toMatchObject({ event_type: EVENTO_RESPOSTA_FALHOU, entity_id: linha.id });
    expect(eventos(banco)[0]!.payload).toEqual({
      organization_id: ORG_A,
      channel_session_id: "sessao-a",
      comment_id: "C-1",
      tipo: "resposta_privada",
      pedido_por: PEDIDO,
      motivo: linha.erro,
    });
  });

  it("conta indisponível (sessão de outra organização) emite falhou com motivo conta_indisponivel", async () => {
    const banco = bancoFalso({
      channel_sessions: [{ ...sessaoA, organization_id: ORG_B }],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = okMeta();
    await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(meta.chamadas).toHaveLength(0);
    expect(eventos(banco).map((e) => [e.event_type, (e.payload as { motivo?: string }).motivo])).toEqual([
      [EVENTO_RESPOSTA_FALHOU, "conta_indisponivel"],
    ]);
  });

  it("expirada (7 dias, comentário desconhecido, 2534025) emite falhou com o motivo", async () => {
    const velho = new Date(AGORA.getTime() - 8 * 24 * 60 * 60_000).toISOString();
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { criado_na_meta_em: velho, recebido_em: velho })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada"), naFila("C-9", "resposta_privada")],
    });
    await processarFilaMetaSocial(banco.db, AGORA, okMeta().fetcher);
    const motivos = eventos(banco)
      .map((e) => `${String(e.event_type)}|${(e.payload as { comment_id: string; motivo: string }).comment_id}|${(e.payload as { motivo: string }).motivo}`)
      .sort();
    expect(motivos).toEqual([
      `${EVENTO_RESPOSTA_FALHOU}|C-1|prazo_de_7_dias`,
      `${EVENTO_RESPOSTA_FALHOU}|C-9|comentario_desconhecido`,
    ]);

    const banco2 = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    await processarFilaMetaSocial(banco2.db, AGORA, erroMeta(400, 2534025).fetcher);
    expect(banco2.t("meta_social_fila_de_envio")[0]!.status).toBe("expirada");
    expect((eventos(banco2)[0]!.payload as { motivo: string }).motivo).toBe("inelegivel:2534025");
  });

  it("destravada (enviando há mais de 10 min) emite falhou com envio_sem_confirmacao", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [
        naFila("C-1", "resposta_publica", { status: "enviando", atualizado_em: new Date(AGORA.getTime() - 11 * 60_000).toISOString() }),
      ],
    });
    const r = await processarFilaMetaSocial(banco.db, AGORA, okMeta().fetcher);
    expect(r.destravadas).toBe(1);
    expect(eventos(banco)).toHaveLength(1);
    expect(eventos(banco)[0]!.payload).toEqual({
      organization_id: ORG_A,
      channel_session_id: "sessao-a",
      comment_id: "C-1",
      tipo: "resposta_publica",
      pedido_por: PEDIDO,
      motivo: "envio_sem_confirmacao",
    });
  });

  it("reagendada (limite da Meta, rede, token) e aguardando NÃO emitem", async () => {
    for (const meta of [erroMeta(400, 613), erroMeta(429, 0), erroMeta(401, 190)]) {
      const banco = bancoFalso({
        channel_sessions: [sessaoA],
        meta_social_comentarios: [comentario("C-1")],
        meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
      });
      const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
      expect(r.reagendadas).toBe(1);
      expect(eventos(banco)).toEqual([]);
    }
    const rede = metaFalsa(() => {
      throw new TypeError("fetch failed");
    });
    const bancoRede = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    expect((await processarFilaMetaSocial(bancoRede.db, AGORA, rede.fetcher)).reagendadas).toBe(1);
    expect(eventos(bancoRede)).toEqual([]);

    const bancoEspera = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [
        naFila("C-1", "resposta_privada", { proxima_tentativa_em: new Date(AGORA.getTime() + 60_000).toISOString() }),
        naFila("C-1", "resposta_publica"),
      ],
    });
    expect((await processarFilaMetaSocial(bancoEspera.db, AGORA, okMeta().fetcher)).aguardando).toBe(1);
    expect(eventos(bancoEspera)).toEqual([]);
  });

  it("emissão que falha depois do envio não reverte nem reenvia: a linha fica enviada", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const rpcOriginal = banco.db.rpc.bind(banco.db) as unknown as (n: string, a: Record<string, unknown>) => Promise<unknown>;
    const db = {
      from: banco.db.from.bind(banco.db),
      rpc: async (nome: string, args: Record<string, unknown>) =>
        nome === "emit_event" ? { data: null, error: { code: "XX000", message: "falhou" } } : rpcOriginal(nome, args),
    } as unknown as SupabaseClient;
    const meta = okMeta();
    const r = await processarFilaMetaSocial(db, AGORA, meta.fetcher);
    expect(r.enviadas).toBe(1);
    expect(banco.t("meta_social_fila_de_envio")[0]).toMatchObject({ status: "enviada", tentativas: 1 });

    // A rodada seguinte não reenvia nem emite nada.
    const r2 = await processarFilaMetaSocial(db, new Date(AGORA.getTime() + 60_000), meta.fetcher);
    expect(r2.examinadas).toBe(0);
    expect(meta.chamadas).toHaveLength(1);
  });
});

// ─── 2. Plataforma na listagem ──────────────────────────────────────────────

describe("listagem de conexões: plataforma", () => {
  it("instagram/messenger pela coluna do canal social; whatsapp para número; null para o intermediado", () => {
    expect(plataformaDaConexao("meta_social", "instagram")).toBe("instagram");
    expect(plataformaDaConexao("meta_social", "messenger")).toBe("messenger");
    expect(plataformaDaConexao("meta_social", null)).toBeNull();
    expect(plataformaDaConexao("meta_social", "facebook")).toBeNull();
    for (const p of ["waha", "meta_cloud", "uazapi", "zernio", "datafy"]) expect(plataformaDaConexao(p, null)).toBe("whatsapp");
    expect(plataformaDaConexao("zernio_social", null)).toBeNull();
    expect(plataformaDaConexao("wacalls", null)).toBeNull();
  });

  it("cada linha traz `plataforma` e não traz a coluna crua", async () => {
    const banco = bancoFalso({
      channel_sessions: [
        { ...sessaoA, created_at: "2026-11-01T00:00:00Z" },
        { id: "zap", organization_id: ORG_A, provider: "waha", archived_at: null, created_at: "2026-11-02T00:00:00Z" },
        { id: "outra", organization_id: ORG_B, provider: "waha", archived_at: null, created_at: "2026-11-02T00:00:00Z" },
      ],
    });
    const r = await listarConexoesDeMensagem(banco.db, ORG_A);
    expect(r.error).toBeNull();
    expect((r.data ?? []).map((l) => [l.id, l.plataforma])).toEqual([
      ["sessao-a", "instagram"],
      ["zap", "whatsapp"],
    ]);
    for (const l of r.data ?? []) expect(l).not.toHaveProperty("meta_social_platform");
  });

  it("banco sem a coluna meta_social_platform: lista igual, plataforma do social null e schemaOutdated", async () => {
    const banco = bancoFalso({
      channel_sessions: [{ id: "zap", organization_id: ORG_A, provider: "waha", archived_at: null, created_at: "2026-11-02T00:00:00Z" }],
    });
    const db = {
      from: (tabela: string) => {
        const q = banco.db.from(tabela) as unknown as { select: (c: string) => unknown };
        const select = q.select.bind(q);
        q.select = (c: string) => {
          if (c.includes("meta_social_platform")) {
            const erro = { data: null, error: { code: "42703", message: "column channel_sessions.meta_social_platform does not exist" } };
            const falho: Record<string, unknown> = {};
            for (const m of ["eq", "in", "is", "order"]) falho[m] = () => falho;
            falho.then = (res: (v: unknown) => unknown) => Promise.resolve(erro).then(res);
            return falho;
          }
          return select(c);
        };
        return q;
      },
    } as unknown as SupabaseClient;
    const r = await listarConexoesDeMensagem(db, ORG_A);
    expect(r.error).toBeNull();
    expect(r.schemaOutdated).toBe(true);
    expect((r.data ?? []).map((l) => [l.id, l.plataforma])).toEqual([["zap", "whatsapp"]]);
  });
});

// ─── 3. Posts ───────────────────────────────────────────────────────────────

describe("codigoDoLink", () => {
  it("aceita /p, /reel, /reels e /tv, com ou sem www, https, query e barra final", () => {
    expect(codigoDoLink("https://www.instagram.com/p/DAbc_12-x/")).toBe("DAbc_12-x");
    expect(codigoDoLink("https://instagram.com/reel/Cxyz123?igsh=abc")).toBe("Cxyz123");
    expect(codigoDoLink("instagram.com/reels/Cxyz123/")).toBe("Cxyz123");
    expect(codigoDoLink("www.instagram.com/tv/B0tv9")).toBe("B0tv9");
    expect(codigoDoLink("  https://www.instagram.com/p/AbC/?utm_source=ig_web_copy_link#x  ")).toBe("AbC");
    expect(codigoDoLink("http://instagram.com/P/AbC")).toBe("AbC");
  });

  it("recusa outro domínio, perfil, caminho a mais, código inválido e lixo", () => {
    for (const ruim of [
      "",
      "https://instagram.com.evil.com/p/AbC/",
      "https://evil.com/instagram.com/p/AbC",
      "https://www.instagram.com/maria/",
      "https://www.instagram.com/p/",
      "https://www.instagram.com/p/AbC/extra",
      "https://www.instagram.com/stories/maria/123",
      "https://www.instagram.com/p/Ab%20C/",
      "javascript:alert(1)",
      "ftp://instagram.com/p/AbC",
      "https://user:pw@instagram.com/p/AbC",
      "https://instagram.com:8443/p/AbC",
      "não é link",
    ])
      expect(codigoDoLink(ruim), ruim).toBeNull();
  });
});

describe("listarPostsRecentes", () => {
  const midias = {
    data: [
      {
        id: "M-1",
        permalink: "https://www.instagram.com/reel/R1/",
        caption: `${"a".repeat(200)}`,
        media_type: "VIDEO",
        media_product_type: "REELS",
        thumbnail_url: "https://cdn/thumb.jpg",
        media_url: "https://cdn/video.mp4",
        timestamp: "2026-11-02T10:00:00+0000",
      },
      { id: "M-2", permalink: "https://www.instagram.com/p/P2/", media_type: "IMAGE", media_url: "https://cdn/foto.jpg" },
    ],
  };

  it("lista com o token no header, legenda curta e miniatura certa", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa(() => ({ status: 200, corpo: midias }));
    const r = await listarPostsRecentes(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a" }, meta.fetcher);
    expect(meta.chamadas).toHaveLength(1);
    const u = new URL(meta.chamadas[0]!.url);
    expect(u.pathname).toBe(`/v26.0/${IG}/media`);
    expect(u.searchParams.get("limit")).toBe("24");
    expect(u.searchParams.get("fields")).toBe("id,permalink,caption,media_type,media_product_type,thumbnail_url,media_url,timestamp");
    expect(meta.chamadas[0]!.url).not.toContain("TOKEN");
    expect(meta.chamadas[0]!.auth).toBe("Bearer TOKEN-DA-PAGINA");
    expect("posts" in r && r.posts).toEqual([
      {
        media_id: "M-1",
        permalink: "https://www.instagram.com/reel/R1/",
        legenda_curta: `${"a".repeat(119)}…`,
        miniatura: "https://cdn/thumb.jpg",
        tipo: "REELS",
        publicado_em: "2026-11-02T10:00:00+0000",
      },
      {
        media_id: "M-2",
        permalink: "https://www.instagram.com/p/P2/",
        legenda_curta: null,
        miniatura: "https://cdn/foto.jpg",
        tipo: "IMAGE",
        publicado_em: null,
      },
    ]);
    if ("posts" in r) for (const p of r.posts) expect(Array.from(p.legenda_curta ?? "").length).toBeLessThanOrEqual(120);
  });

  it("limite acima de 50 vira 50", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa(() => ({ status: 200, corpo: { data: [] } }));
    await listarPostsRecentes(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", limite: 500 }, meta.fetcher);
    expect(new URL(meta.chamadas[0]!.url).searchParams.get("limit")).toBe("50");
  });

  it("sessão de outra organização, arquivada ou de Messenger → conta_indisponivel, sem chamar a Meta", async () => {
    for (const sessao of [
      { ...sessaoA, organization_id: ORG_B },
      { ...sessaoA, archived_at: "2026-11-01T00:00:00Z" },
      { ...sessaoA, meta_social_platform: "messenger" },
    ]) {
      const banco = bancoFalso({ channel_sessions: [sessao] });
      const meta = metaFalsa(() => ({ status: 200, corpo: midias }));
      expect(await listarPostsRecentes(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a" }, meta.fetcher)).toEqual({
        erro: "conta_indisponivel",
      });
      expect(meta.chamadas).toHaveLength(0);
    }
  });

  it("erro da Meta → meta_falhou", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    expect(
      await listarPostsRecentes(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a" }, erroMeta(500, 2).fetcher),
    ).toEqual({ erro: "meta_falhou" });
  });
});

describe("resolverPostPorLink", () => {
  const pagina = (n: number, comProxima: boolean) => ({
    data: Array.from({ length: 50 }, (_, i) => ({ id: `M-${n}-${i}`, permalink: `https://www.instagram.com/p/C${n}x${i}/` })),
    paging: comProxima ? { cursors: { after: `CUR-${n}` }, next: "https://graph.facebook.com/next?access_token=NAO" } : {},
  });

  it("pagina pelo cursor `after` até achar o código do permalink", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa((url) => {
      const depois = new URL(url).searchParams.get("after");
      return { status: 200, corpo: pagina(depois ? Number(depois.split("-")[1]) + 1 : 0, true) };
    });
    const r = await resolverPostPorLink(
      banco.db,
      { organizationId: ORG_A, channelSessionId: "sessao-a", link: "https://instagram.com/reel/C2x7?igsh=1" },
      meta.fetcher,
    );
    expect(r).toEqual({ media_id: "M-2-7" });
    expect(meta.chamadas).toHaveLength(3);
    expect(new URL(meta.chamadas[1]!.url).searchParams.get("after")).toBe("CUR-0");
    expect(new URL(meta.chamadas[0]!.url).searchParams.get("limit")).toBe("50");
    for (const c of meta.chamadas) expect(c.url).not.toContain("access_token");
  });

  it("acha também pelo `shortcode` quando o permalink não vem", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa(() => ({ status: 200, corpo: { data: [{ id: "M-S", shortcode: "SC1" }] } }));
    expect(
      await resolverPostPorLink(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", link: "https://instagram.com/p/SC1/" }, meta.fetcher),
    ).toEqual({ media_id: "M-S" });
    expect(new URL(meta.chamadas[0]!.url).searchParams.get("fields")).toBe("id,permalink,shortcode");
  });

  it("não achando, para em 4 páginas e responde post_nao_encontrado", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    let n = 0;
    const meta = metaFalsa(() => ({ status: 200, corpo: pagina(n++, true) }));
    const r = await resolverPostPorLink(
      banco.db,
      { organizationId: ORG_A, channelSessionId: "sessao-a", link: "https://www.instagram.com/p/NAOEXISTE/" },
      meta.fetcher,
    );
    expect(r).toEqual({ erro: "post_nao_encontrado" });
    expect(meta.chamadas).toHaveLength(4);
  });

  it("última página sem `next` para antes das 4", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa(() => ({ status: 200, corpo: pagina(0, false) }));
    expect(
      await resolverPostPorLink(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", link: "instagram.com/p/ZZZ" }, meta.fetcher),
    ).toEqual({ erro: "post_nao_encontrado" });
    expect(meta.chamadas).toHaveLength(1);
  });

  it("link inválido não chama a Meta; sessão de outra organização é conta_indisponivel", async () => {
    const banco = bancoFalso({ channel_sessions: [{ ...sessaoA, organization_id: ORG_B }] });
    const meta = metaFalsa(() => ({ status: 200, corpo: pagina(0, false) }));
    expect(
      await resolverPostPorLink(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", link: "https://evil.com/p/X" }, meta.fetcher),
    ).toEqual({ erro: "link_invalido" });
    expect(
      await resolverPostPorLink(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", link: "https://instagram.com/p/C0x1" }, meta.fetcher),
    ).toEqual({ erro: "conta_indisponivel" });
    expect(meta.chamadas).toHaveLength(0);
  });
});
