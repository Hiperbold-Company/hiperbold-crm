/**
 * GET /api/v1/health/scheduler — o agendador de crons está chamando o app?
 *
 * Pública, como `/api/v1/health`. O scheduler não tem código próprio para
 * bater: o app grava o batimento quando recebe um cron autorizado (rota
 * `cron/event-log-drain`, 1×/min). 200 se o último batimento tem até 180 s;
 * 503 caso contrário. Só estado e idade: nenhum segredo nem dado de organização.
 */
import { responderSaudeDoServico } from "@/lib/system/batimento-app";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return responderSaudeDoServico("scheduler");
}
