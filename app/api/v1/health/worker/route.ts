/**
 * GET /api/v1/health/worker — o worker (agente de IA 24/7) está batendo?
 *
 * Pública, como `/api/v1/health`, para o monitor externo (Uptime Kuma) bater
 * nela. Devolve só o estado e a idade do último batimento: nenhum segredo,
 * endereço nem dado de organização. 200 se o último batimento tem até 180 s;
 * 503 caso contrário (inclusive sem batimento nenhum ou banco fora).
 */
import { responderSaudeDoServico } from "@/lib/system/batimento-app";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return responderSaudeDoServico("worker");
}
