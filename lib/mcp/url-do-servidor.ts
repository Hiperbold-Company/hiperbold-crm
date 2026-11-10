/**
 * Endereço PÚBLICO do servidor MCP desta instalação (`/api/mcp`), derivado da URL
 * pública já configurada (`NEXT_PUBLIC_APP_URL`) — nunca de cabeçalho da requisição
 * e nunca fixo no código: o produto é white-label e cada instalação tem o seu domínio.
 */
import { env } from "@/lib/env";

export const CAMINHO_DO_MCP = "/api/mcp";

export function urlDoServidorMcp(): string {
  return `${(env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "")}${CAMINHO_DO_MCP}`;
}
