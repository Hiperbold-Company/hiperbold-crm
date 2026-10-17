import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LIMITE_ITENS_DE_FAQ,
  LIMITE_MARKDOWN_BLOB,
  LIMITE_PERGUNTA,
  LIMITE_RESPOSTA,
  alterarFonteSchema,
  criarFonteSchema,
} from "@/lib/ai/rag/administracao-fontes";
import { crmCreateKnowledgeSource, crmUpdateKnowledgeSource } from "@/lib/mcp/tools/administracao-conhecimento";

/**
 * Tetos de tamanho do material de conhecimento cadastrado por API/MCP. Sem eles,
 * uma só chamada enfileirava texto sem limite para o indexador.
 */
const par = (q = "pergunta?", a = "resposta.") => ({ question: q, answer: a });
const base = { source_type: "faq", name: "Material" };

describe("criarFonteSchema — tetos", () => {
  it("material dentro dos tetos passa (controle)", () => {
    expect(
      criarFonteSchema.safeParse({
        ...base,
        items: [par("p".repeat(LIMITE_PERGUNTA), "r".repeat(LIMITE_RESPOSTA))],
      }).success,
    ).toBe(true);
    expect(
      criarFonteSchema.safeParse({ ...base, markdown_blob: "x".repeat(LIMITE_MARKDOWN_BLOB) }).success,
    ).toBe(true);
  });

  it("markdown_blob acima do teto é recusado", () => {
    expect(
      criarFonteSchema.safeParse({ ...base, markdown_blob: "x".repeat(LIMITE_MARKDOWN_BLOB + 1) }).success,
    ).toBe(false);
  });

  it("pergunta e resposta acima do teto são recusadas", () => {
    expect(criarFonteSchema.safeParse({ ...base, items: [par("p".repeat(LIMITE_PERGUNTA + 1))] }).success).toBe(false);
    expect(
      criarFonteSchema.safeParse({ ...base, items: [par("ok?", "r".repeat(LIMITE_RESPOSTA + 1))] }).success,
    ).toBe(false);
  });

  it("número de itens acima do teto é recusado", () => {
    const itens = Array.from({ length: LIMITE_ITENS_DE_FAQ + 1 }, () => par());
    expect(criarFonteSchema.safeParse({ ...base, items: itens }).success).toBe(false);
    expect(criarFonteSchema.safeParse({ ...base, items: itens.slice(1) }).success).toBe(true);
  });
});

describe("alterarFonteSchema — tetos", () => {
  it("itens acima do teto, pergunta ou resposta longas são recusados", () => {
    const itens = Array.from({ length: LIMITE_ITENS_DE_FAQ + 1 }, () => par());
    expect(alterarFonteSchema.safeParse({ items: itens }).success).toBe(false);
    expect(alterarFonteSchema.safeParse({ items: [par("p".repeat(LIMITE_PERGUNTA + 1))] }).success).toBe(false);
    expect(alterarFonteSchema.safeParse({ items: [par("ok?", "r".repeat(LIMITE_RESPOSTA + 1))] }).success).toBe(false);
    expect(alterarFonteSchema.safeParse({ items: [par()] }).success).toBe(true);
  });
});

describe("formato das tools MCP (o que o SDK valida antes do handler)", () => {
  it("crm_create_knowledge_source recusa blob, pergunta, resposta e itens acima do teto", () => {
    const forma = z.object(crmCreateKnowledgeSource.inputSchema);
    expect(forma.safeParse({ ...base, markdown_blob: "x".repeat(LIMITE_MARKDOWN_BLOB + 1) }).success).toBe(false);
    expect(forma.safeParse({ ...base, items: [par("p".repeat(LIMITE_PERGUNTA + 1))] }).success).toBe(false);
    expect(forma.safeParse({ ...base, items: [par("ok?", "r".repeat(LIMITE_RESPOSTA + 1))] }).success).toBe(false);
    expect(
      forma.safeParse({ ...base, items: Array.from({ length: LIMITE_ITENS_DE_FAQ + 1 }, () => par()) }).success,
    ).toBe(false);
    expect(forma.safeParse({ ...base, items: [par()] }).success).toBe(true);
  });

  it("crm_update_knowledge_source recusa itens e textos acima do teto", () => {
    const forma = z.object(crmUpdateKnowledgeSource.inputSchema);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      forma.safeParse({ source_id: id, items: Array.from({ length: LIMITE_ITENS_DE_FAQ + 1 }, () => par()) }).success,
    ).toBe(false);
    expect(forma.safeParse({ source_id: id, items: [par("ok?", "r".repeat(LIMITE_RESPOSTA + 1))] }).success).toBe(
      false,
    );
    expect(forma.safeParse({ source_id: id, items: [par()] }).success).toBe(true);
  });
});
