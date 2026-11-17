/**
 * 1015: campo personalizado NÃO PÚBLICO (`publico: false`) — valor e definição — só sai para
 * administrador. Nunca para a IA, nunca no texto que vai ao cliente, nunca para quem não é admin.
 *
 * Os dublês são só a FRONTEIRA (cliente Supabase e `pg.Pool`); o recorte, a leitura das chaves e o
 * render são o código real.
 */
import { describe, expect, it } from "vitest";

import { recortarCamposRestritosDoContexto } from "@/lib/automation/campos-do-render";
import { contextoDoContato, renderizarTextoDeFollowup } from "@/lib/automation/texto-do-followup";
import { renderTemplate } from "@/lib/automation/template";
import { carregarFatosDaAutomacaoPg } from "@/lib/automacoes/carregar-fatos-pg";
import { renderizar } from "@/lib/automacoes/template-vars";
import { camposDoDestinatario } from "@/lib/campanhas/consulta-de-audiencia";
import { chavesRestritasDaOrganizacao, chavesRestritasDaOrganizacaoPg } from "@/lib/campos/chaves-restritas";
import { recusaDoFiltroPorCampoRestrito } from "@/lib/campos/filtro-restrito";
import { recortarLinhaDaResposta } from "@/lib/campos/resposta-recortada";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

// ─── dublê do Supabase: cada tabela responde o que o teste mandar ─────────────
type Resposta = { data: unknown; error: { message: string } | null };
function supabaseFalso(tabelas: Record<string, Resposta | ((chamada: number) => Resposta)>) {
  const chamadas: Record<string, number> = {};
  return {
    from(tabela: string) {
      const n = (chamadas[tabela] = (chamadas[tabela] ?? 0) + 1);
      const r = tabelas[tabela];
      const resposta: Resposta =
        r === undefined
          ? { data: null, error: { message: `tabela ${tabela} fora do dublê` } }
          : typeof r === "function"
            ? r(n)
            : r;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit", "or", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({
        data: Array.isArray(resposta.data) ? (resposta.data[0] ?? null) : resposta.data,
        error: resposta.error,
      });
      b.then = (ok: (v: Resposta) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, ko);
      return b;
    },
  } as never;
}

const DEFINICOES_OK: Resposta = { data: [{ key: "segredo" }], error: null };
const FUNIS_OK: Resposta = { data: [{ settings: { fields: [{ key: "legado", publico: false }, { key: "pub" }] } }], error: null };

// ─── dublê do pg ──────────────────────────────────────────────────────────────
function poolFalso(opcoes: { chavesFalham?: boolean } = {}) {
  return {
    async query(sql: string) {
      if (/custom_field_definitions/.test(sql)) {
        if (opcoes.chavesFalham) throw new Error("fora do ar");
        return { rows: [{ key: "SEGREDO" }] };
      }
      if (/settings->'fields'/.test(sql)) return { rows: [{ fields: [{ key: "legado", publico: false }] }] };
      if (/from crm_pipelines/.test(sql)) return { rows: [{ settings: { fields: [] } }] };
      if (/from contacts/.test(sql)) {
        return { rows: [{ id: CONTATO, name: "Ana Silva", custom_fields: { segredo_do_contato: "C1" }, tags: [] }] };
      }
      if (/from crm_leads/.test(sql)) {
        return {
          rows: [
            {
              id: "l1",
              pipeline_id: "p1",
              stage_id: "s1",
              status: "open",
              custom_fields: { segredo: "VALOR-RESTRITO", legado: "LEGADO-RESTRITO", pub: "publico-ok" },
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as never;
}

describe("as chaves restritas da organização (item 4: definições + funis no legado)", () => {
  it("une custom_field_definitions com os publico:false de settings.fields dos funis", async () => {
    const r = await chavesRestritasDaOrganizacao(
      supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: FUNIS_OK }),
      ORG,
    );
    expect(r).toEqual({ ok: true, chaves: new Set(["segredo", "legado"]) });
  });

  it("organização sem definição nenhuma (legado) ainda esconde o campo marcado no funil", async () => {
    const r = await chavesRestritasDaOrganizacao(
      supabaseFalso({ custom_field_definitions: { data: [], error: null }, crm_pipelines: FUNIS_OK }),
      ORG,
    );
    expect(r.ok && [...r.chaves]).toEqual(["legado"]);
  });

  it("falha de qualquer uma das duas leituras volta declarada", async () => {
    const semFunis = await chavesRestritasDaOrganizacao(
      supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: { data: null, error: { message: "x" } } }),
      ORG,
    );
    expect(semFunis.ok).toBe(false);
  });

  it("a versão pg faz a mesma união e a mesma falha declarada", async () => {
    const r = await chavesRestritasDaOrganizacaoPg(poolFalso(), ORG);
    expect(r).toEqual({ ok: true, chaves: new Set(["segredo", "legado"]) });
    expect((await chavesRestritasDaOrganizacaoPg(poolFalso({ chavesFalham: true }), ORG)).ok).toBe(false);
  });
});

describe("o texto do follow-up que sai ao cliente (item 1)", () => {
  const TEXTO = "Oi {{nome}}! {{segredo}} {{lead.custom_fields.legado}} {{pub}} {{contact.custom_fields.segredo_do_contato}}";

  it("campo restrito (da organização e do funil) sai vazio; o público sai", async () => {
    const contexto = await contextoDoContato(poolFalso() as never, ORG, CONTATO);
    const texto = renderizarTextoDeFollowup(TEXTO, contexto);
    expect(texto).not.toContain("VALOR-RESTRITO");
    expect(texto).not.toContain("LEGADO-RESTRITO");
    expect(texto).toContain("publico-ok");
    expect(texto).toContain("Ana Silva");
  });

  it("sem conseguir ler as chaves, NENHUM campo personalizado vira texto (falha fechada)", async () => {
    const contexto = await contextoDoContato(poolFalso({ chavesFalham: true }) as never, ORG, CONTATO);
    const texto = renderizarTextoDeFollowup(TEXTO, contexto);
    expect(texto).not.toContain("VALOR-RESTRITO");
    expect(texto).not.toContain("publico-ok");
    expect(texto).not.toContain("C1");
    expect(texto).toContain("Oi Ana Silva!");
  });

  it("o carregador do motor (Supabase) marca o contexto do mesmo jeito", async () => {
    const contexto: Record<string, unknown> = {
      contact: { name: "Ana" },
      lead: { custom_fields: { segredo: "VALOR-RESTRITO", pub: "publico-ok" } },
    };
    await recortarCamposRestritosDoContexto(
      contexto,
      supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: FUNIS_OK }),
      ORG,
    );
    const texto = renderTemplate("{{segredo}}|{{pub}}|{{lead.custom_fields}}", contexto);
    expect(texto).toBe("|publico-ok|");
  });
});

describe("as automações visuais (item 1: lib/automacoes)", () => {
  it("{{campo.x}} restrito sai vazio; o público sai; as condições ainda veem o valor", async () => {
    const fatos = await carregarFatosDaAutomacaoPg(poolFalso(), ORG, CONTATO, {});
    expect(fatos.negocio?.custom_fields.segredo).toBe("VALOR-RESTRITO");
    const texto = renderizar("{{campo.segredo}}|{{campo.legado}}|{{campo.pub}}|{{lead.custom_fields.segredo}}", fatos, new Date());
    expect(texto).toBe("||publico-ok|");
  });

  it("sem conseguir ler as chaves, nenhum campo personalizado vira texto", async () => {
    const fatos = await carregarFatosDaAutomacaoPg(poolFalso({ chavesFalham: true }), ORG, CONTATO, {});
    expect(fatos.camposRestritos).toBe("todas");
    expect(renderizar("{{campo.pub}}|{{contact.name}}", fatos, new Date())).toBe("|Ana Silva");
  });
});

describe("as campanhas (item 1: texto e variáveis de modelo do WhatsApp)", () => {
  const leads = (n: number): Resposta =>
    n === 1
      ? {
          data: [{ contact_id: CONTATO, created_at: "2026-01-01", id: "l1", custom_fields: { segredo: "X", pub: "ok" } }],
          error: null,
        }
      : { data: [], error: null };

  it("o campo restrito não chega ao renderizador da campanha", async () => {
    const r = await camposDoDestinatario(
      supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: FUNIS_OK, crm_leads: leads }),
      { organizationId: ORG, contactId: CONTATO, corpo: "{{lead.pub}}" },
    );
    expect(r.lead).toEqual({ pub: "ok" });
  });

  it("sem conseguir ler as chaves, os campos chegam vazios (o destinatário cai como variável ausente)", async () => {
    const r = await camposDoDestinatario(
      supabaseFalso({ custom_field_definitions: { data: null, error: { message: "x" } }, crm_pipelines: FUNIS_OK, crm_leads: leads }),
      { organizationId: ORG, contactId: CONTATO, corpo: "{{lead.pub}}" },
    );
    expect(r.lead).toEqual({});
  });
});

describe("a resposta das escritas de negócio (item 3)", () => {
  const linha = { id: "l1", custom_fields: { segredo: "X", pub: "ok" } };
  const sb = () => supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: FUNIS_OK });

  it("administrador recebe tudo; agente e gerente não recebem o restrito", async () => {
    expect(await recortarLinhaDaResposta(sb(), ORG, linha, "admin", "r")).toEqual({ ok: true, linha });
    for (const papel of ["agent", "manager", "ia"] as const) {
      const r = await recortarLinhaDaResposta(sb(), ORG, linha, papel, "r");
      expect(r.ok && r.linha.custom_fields).toEqual({ pub: "ok" });
    }
    const semPapel = await recortarLinhaDaResposta(sb(), ORG, linha, null, "r");
    expect(semPapel.ok && semPapel.linha.custom_fields).toEqual({ pub: "ok" });
  });

  it("sem conseguir ler as chaves, quem não é admin recebe 500 em vez do valor", async () => {
    const r = await recortarLinhaDaResposta(
      supabaseFalso({ custom_field_definitions: { data: null, error: { message: "x" } } }),
      ORG,
      linha,
      "agent",
      "r",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.resposta.status).toBe(500);
  });
});

describe("filtro da lista por campo restrito (item 5)", () => {
  const sb = () => supabaseFalso({ custom_field_definitions: DEFINICOES_OK, crm_pipelines: FUNIS_OK });

  it("quem não é admin leva 403 ao filtrar por chave restrita (sem diferenciar maiúsculas)", async () => {
    expect((await recusaDoFiltroPorCampoRestrito(sb(), ORG, "Segredo", "manager", "r"))?.status).toBe(403);
    expect((await recusaDoFiltroPorCampoRestrito(sb(), ORG, "legado", "viewer", "r"))?.status).toBe(403);
  });

  it("admin filtra; chave pública passa; sem filtro não consulta nada", async () => {
    expect(await recusaDoFiltroPorCampoRestrito(sb(), ORG, "segredo", "admin", "r")).toBeNull();
    expect(await recusaDoFiltroPorCampoRestrito(sb(), ORG, "pub", "agent", "r")).toBeNull();
    expect(await recusaDoFiltroPorCampoRestrito(supabaseFalso({}), ORG, null, "agent", "r")).toBeNull();
  });

  it("sem conseguir ler as chaves, o filtro por campo de quem não é admin é recusado", async () => {
    expect((await recusaDoFiltroPorCampoRestrito(supabaseFalso({}), ORG, "pub", "agent", "r"))?.status).toBe(500);
  });
});
