import { describe, expect, it } from "vitest";

import {
  agruparCampos,
  grupoDoCampo,
  GRUPOS_DE_CAMPO,
  inferirGrupoPelaChave,
} from "@/lib/leads/grupo-do-campo";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { customFieldSchema, pipelineConfigPatchSchema } from "@/lib/schemas/settings";

/**
 * O grupo do campo do funil na ficha: "Dados do lead" ou "Rastreamento".
 * Ausente é INFERIDO pela chave — funil antigo não precisa ser reeditado.
 */
describe("inferirGrupoPelaChave", () => {
  it.each([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "utm_id",
    "gclid",
    "fbclid",
    "gbraid",
    "wbraid",
    "ttclid",
    "msclkid",
    "src",
    "sck",
    "xcod",
  ])("%s é rastreamento", (chave) => {
    expect(inferirGrupoPelaChave(chave)).toBe("rastreamento");
  });

  it.each(["empresa", "cargo", "nivel_academico", "instituicao", "telefone", "origem"])(
    "%s é dado do lead",
    (chave) => {
      expect(inferirGrupoPelaChave(chave)).toBe("dados");
    },
  );

  it("ignora caixa e espaços ao redor", () => {
    expect(inferirGrupoPelaChave("UTM_Source")).toBe("rastreamento");
    expect(inferirGrupoPelaChave(" GCLID ")).toBe("rastreamento");
  });

  it("não confunde chave que apenas CONTÉM o nome (utm sem sublinhado, gclid como sufixo)", () => {
    expect(inferirGrupoPelaChave("utmx")).toBe("dados");
    expect(inferirGrupoPelaChave("meu_gclid")).toBe("dados");
    expect(inferirGrupoPelaChave("source")).toBe("dados");
  });
});

describe("grupoDoCampo", () => {
  it("o grupo declarado vence a inferência, nos dois sentidos", () => {
    expect(grupoDoCampo({ key: "utm_source", grupo: "dados" })).toBe("dados");
    expect(grupoDoCampo({ key: "empresa", grupo: "rastreamento" })).toBe("rastreamento");
  });

  it("ausente (ou nulo) cai na inferência", () => {
    expect(grupoDoCampo({ key: "utm_term" })).toBe("rastreamento");
    expect(grupoDoCampo({ key: "cargo", grupo: null })).toBe("dados");
  });
});

describe("agruparCampos", () => {
  const campos = [
    { key: "utm_source" },
    { key: "empresa" },
    { key: "gclid" },
    { key: "cargo" },
    { key: "origem", grupo: "rastreamento" as const },
  ];

  it("devolve Dados do lead ANTES de Rastreamento, na ordem do funil dentro de cada um", () => {
    const blocos = agruparCampos(campos);
    expect(blocos.map((b) => b.grupo)).toEqual([...GRUPOS_DE_CAMPO]);
    expect(blocos[0]!.campos.map((c) => c.key)).toEqual(["empresa", "cargo"]);
    expect(blocos[1]!.campos.map((c) => c.key)).toEqual(["utm_source", "gclid", "origem"]);
  });

  it("bloco vazio NÃO entra na resposta", () => {
    expect(agruparCampos([{ key: "empresa" }]).map((b) => b.grupo)).toEqual(["dados"]);
    expect(agruparCampos([{ key: "utm_source" }]).map((b) => b.grupo)).toEqual(["rastreamento"]);
    expect(agruparCampos([])).toEqual([]);
  });
});

describe("customFieldSchema.grupo", () => {
  const base = { key: "empresa", label: "Empresa", type: "text" as const };

  it("é opcional: o campo de um funil antigo continua válido", () => {
    const r = customFieldSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.grupo).toBeUndefined();
  });

  it("aceita os dois grupos e recusa outro valor", () => {
    expect(customFieldSchema.safeParse({ ...base, grupo: "dados" }).success).toBe(true);
    expect(customFieldSchema.safeParse({ ...base, grupo: "rastreamento" }).success).toBe(true);
    expect(customFieldSchema.safeParse({ ...base, grupo: "outro" }).success).toBe(false);
  });

  it("sobrevive à leitura do jsonb do funil e à gravação pela configuração do funil", () => {
    const lidos = camposDoFunil({ fields: [{ ...base, key: "utm_source", grupo: "dados" }] });
    expect(lidos[0]!.grupo).toBe("dados");
    const patch = pipelineConfigPatchSchema.safeParse({ fields: [{ ...base, grupo: "rastreamento" }] });
    expect(patch.success && patch.data.fields?.[0]?.grupo).toBe("rastreamento");
  });
});
