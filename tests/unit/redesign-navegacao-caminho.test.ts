import { describe, expect, it } from "vitest";
import { caminhoNoCatalogo } from "@/components/shell/redesign/navegacao";

describe("caminhoNoCatalogo", () => {
  it("o quadro de um funil é o destino Pipeline", () => {
    expect(caminhoNoCatalogo("/app/pipelines/683f0376")).toBe("/app/kanban");
    expect(caminhoNoCatalogo("/app/pipelines")).toBe("/app/kanban");
  });
  it("não confunde prefixo parecido nem mexe no resto", () => {
    expect(caminhoNoCatalogo("/app/pipelinesx")).toBe("/app/pipelinesx");
    expect(caminhoNoCatalogo("/app/inbox/1")).toBe("/app/inbox/1");
  });
});
