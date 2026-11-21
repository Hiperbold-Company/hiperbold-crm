import { describe, expect, it } from "vitest";

import { abaDaTela } from "@/components/shell/redesign/navegacao";

describe("abaDaTela — uma aba acesa por vez", () => {
  const abas = ["/app/kanban", "/app/campanhas", "/app/contacts", "/app/tasks", "/app/tasks/planos"];

  it("na subtela, acende só a aba mais específica", () => {
    expect(abaDaTela("/app/tasks/planos", abas)).toBe("/app/tasks/planos");
  });

  it("na tela-mãe, acende a aba dela", () => {
    expect(abaDaTela("/app/tasks", abas)).toBe("/app/tasks");
  });

  it("o quadro de um funil acende o Pipeline", () => {
    expect(abaDaTela("/app/pipelines/683f0376", abas)).toBe("/app/kanban");
  });

  it("tela fora das abas não acende nenhuma", () => {
    expect(abaDaTela("/app/inicio", abas)).toBeNull();
  });
});
