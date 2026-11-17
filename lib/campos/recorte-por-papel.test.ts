/**
 * O recorte por papel dos campos não públicos (1015): admin recebe, gerente e agente não, e o agente
 * de IA e as variáveis de automação NUNCA — nem quando a organização só tem administradores.
 * Prova pelo comportamento das saídas reais (o contexto do agente e o texto renderizado da
 * automação), não pela forma da função.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarFontesDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { hidratarCamposDoFunil, recortarCamposRestritosDoContexto } from "@/lib/automation/campos-do-render";
import { renderTemplate } from "@/lib/automation/template";

import {
  chavesRestritasDosCampos,
  leitorVeCamposRestritos,
  preservarValoresRestritos,
  recortarCampos,
  recortarLinha,
  recortarSettingsDoFunil,
} from "./recorte-por-papel";

const CAMPOS = [
  { key: "origem", label: "Origem", type: "text" },
  { key: "Margem", label: "Margem", type: "number", publico: false },
];
const VALORES = { origem: "site", margem: "valor-da-margem" };
const RESTRITAS = chavesRestritasDosCampos(CAMPOS);

describe("recorte por papel: telas e exportação", () => {
  it("admin vê a definição e o valor", () => {
    expect(leitorVeCamposRestritos("admin")).toBe(true);
    expect(recortarCampos(CAMPOS, "admin")).toHaveLength(2);
    expect(recortarLinha({ custom_fields: VALORES }, RESTRITAS, "admin").custom_fields).toEqual(VALORES);
  });

  it.each(["manager", "agent", "ai_operator", "viewer"] as const)("%s não recebe a definição nem o valor (sem diferenciar maiúsculas)", (papel) => {
    expect(leitorVeCamposRestritos(papel)).toBe(false);
    expect(recortarCampos(CAMPOS, papel).map((c) => c.key)).toEqual(["origem"]);
    expect(recortarLinha({ id: "l1", custom_fields: VALORES }, RESTRITAS, papel)).toEqual({ id: "l1", custom_fields: { origem: "site" } });
    const settings = recortarSettingsDoFunil({ fields: CAMPOS, lost_reasons: ["x"] }, papel);
    expect(settings).toEqual({ fields: [CAMPOS[0]], lost_reasons: ["x"] });
  });

  it("papel ausente não vê", () => {
    expect(leitorVeCamposRestritos(null)).toBe(false);
  });

  it("o PATCH que substitui custom_fields não apaga o valor restrito que quem gravou nem recebeu", () => {
    expect(preservarValoresRestritos({ origem: "loja" }, VALORES, RESTRITAS)).toEqual({ origem: "loja", margem: "valor-da-margem" });
    // O administrador que manda a chave decide o valor.
    expect(preservarValoresRestritos({ origem: "loja", margem: null }, VALORES, RESTRITAS)).toEqual({ origem: "loja", margem: null });
  });
});

describe("recorte por papel: o agente de IA nunca recebe", () => {
  it("o contexto do atendimento não leva o campo restrito, só o público", () => {
    const TENANT = "org-1";
    const contexto = normalizarFontesDoAtendimento(
      {
        contato: { id: "c1", organization_id: TENANT },
        negocios: [
          {
            id: "l1",
            organization_id: TENANT,
            contact_id: "c1",
            status: "open",
            title: "N",
            custom_fields: VALORES,
            field_definitions: CAMPOS,
          },
        ],
        notas: [],
        atividades: [],
        propostas: [],
        agenda: [],
        retornos: [],
        caso: [],
        job: null,
        conversa: { organization_id: TENANT, contact_id: "c1" },
      },
      TENANT,
    );
    const texto = JSON.stringify(contexto);
    expect(texto).toContain("site");
    expect(texto).not.toContain("Margem");
    expect(texto).not.toContain("valor-da-margem");
    expect(leitorVeCamposRestritos("ia")).toBe(false);
  });
});

describe("recorte por papel: a variável de automação nunca recebe", () => {
  /** Só a borda é falsa: o banco devolve as definições não públicas da organização. */
  function adminCom(chaves: string[] | "falha"): SupabaseClient {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: { settings: { fields: CAMPOS } }, error: null });
    q.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(
        chaves === "falha"
          ? { data: null, error: { code: "XX000", message: "x" } }
          : { data: chaves.map((key) => ({ key })), error: null },
      ).then(ok);
    return { from: () => q } as unknown as SupabaseClient;
  }

  it("{{margem}} e {{lead.custom_fields.margem}} saem vazios; {{origem}} sai", async () => {
    const context: Record<string, unknown> = { lead: { pipeline_id: "p1", custom_fields: { ...VALORES } }, contact: { custom_fields: { cpf: "123" } } };
    await hidratarCamposDoFunil(context, adminCom(["cpf"]), "org-1");
    expect(renderTemplate("{{origem}}|{{margem}}|{{lead.custom_fields.margem}}|{{campo.cpf}}|{{campo.cpf|\"-\"}}", context)).toBe(
      "site||||-",
    );
    // As condições continuam vendo o dado: o recorte é do TEXTO, não do contexto.
    expect((context.lead as { custom_fields: Record<string, unknown> }).custom_fields.margem).toBe("valor-da-margem");
  });

  it("sem conseguir ler quais chaves são restritas, nenhum campo personalizado vira texto", async () => {
    const context: Record<string, unknown> = { lead: { custom_fields: { origem: "site" } } };
    await recortarCamposRestritosDoContexto(context, adminCom("falha"), "org-1");
    expect(renderTemplate("[{{origem}}][{{lead.custom_fields.origem}}]", context)).toBe("[][]");
  });
});
