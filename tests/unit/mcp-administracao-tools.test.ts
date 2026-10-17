/**
 * Tools MCP de administração (API fase 1): o papel/escopo de cada uma é o da
 * rota/tela equivalente, o catálogo as declara 1:1 e nenhuma é alcançável pelo
 * agente publicado.
 */
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";

const ESPERADO: Record<string, { role: string; scope: string }> = {
  crm_get_pipeline_config: { role: "manager", scope: "mcp:read" },
  crm_update_pipeline_config: { role: "admin", scope: "mcp:write" },
  crm_update_webhook_source: { role: "manager", scope: "mcp:write" },
  crm_delete_webhook_source: { role: "manager", scope: "mcp:write" },
  crm_get_organization_settings: { role: "manager", scope: "mcp:read" },
  crm_update_organization_settings: { role: "admin", scope: "mcp:write" },
};

describe("tools MCP de administração", () => {
  it.each(Object.entries(ESPERADO))("%s: papel e escopo da rota equivalente, no catálogo, só humano", (nome, e) => {
    const tool = allTools.find((t) => t.name === nome);
    expect(tool, `${nome} não registrada`).toBeTruthy();
    expect(tool!.requiresRole).toBe(e.role);
    expect(tool!.requiresScope).toBe(e.scope);
    const entrada = TOOL_CATALOG.find((t) => t.name === nome);
    expect(entrada, `${nome} fora do catálogo`).toBeTruthy();
    expect(entrada!.category).toBe(tool!.category);
    expect(entrada!.apenasHumano).toBe(true);
  });

  it("criar/editar etapa aceita cor #RRGGBB e recusa o resto", () => {
    for (const nome of ["crm_create_stage", "crm_update_stage"]) {
      const tool = allTools.find((t) => t.name === nome)!;
      const cor = tool.inputSchema.color as unknown as { safeParse: (v: unknown) => { success: boolean } };
      expect(cor.safeParse("#3b82f6").success).toBe(true);
      expect(cor.safeParse("azul").success).toBe(false);
      expect(cor.safeParse("#fff").success).toBe(false);
    }
  });
});
