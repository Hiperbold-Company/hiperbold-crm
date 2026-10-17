/**
 * A cor de uma coluna do funil (`crm_stages.color`).
 *
 * Mesma régua do CHECK `crm_stages_color_format` do banco — `#RRGGBB` — para a
 * recusa sair em português, antes de tocar no banco, em vez de um `23514` cru.
 * Sem `transform`: o schema também descreve o input das tools MCP (JSON Schema),
 * que não representa transformações. A coluna tolera as duas caixas.
 */
import { z } from "zod";

export const corDaEtapaSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor no formato #RRGGBB, por exemplo #3b82f6.");
