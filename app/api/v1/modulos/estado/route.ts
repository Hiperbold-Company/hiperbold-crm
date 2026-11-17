import { z } from "zod";

import { ok } from "@/lib/api/wrappers";
import { extensionFailure, operationKey, requireExtensionPlatform } from "@/lib/extensions/http";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ESTADOS_DO_MODULO, definirEstadoDoModulo } from "@/lib/modulos/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  modulo: z.string().min(1).max(40),
  ligado: z.boolean(),
  estado_visto: z.enum(ESTADOS_DO_MODULO),
});

/** Desliga ou religa um módulo de tabela NA INSTÂNCIA (migration 1016) — o mesmo gate e o mesmo
 * contrato do instalar: administrador da instalação, `Idempotency-Key` obrigatório. `estado_visto`
 * é o estado que a tela mostrou; se outra sessão o mudou, a resposta é 409 e nada muda. Desligar
 * não apaga dado nenhum. */
export async function POST(request: Request): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    const key = operationKey(request);
    const input = bodySchema.parse(await request.json());
    return ok(
      await definirEstadoDoModulo(authz.user.id, key, input.modulo, input.ligado, input.estado_visto),
    );
  } catch (error) {
    return extensionFailure(error);
  }
}
