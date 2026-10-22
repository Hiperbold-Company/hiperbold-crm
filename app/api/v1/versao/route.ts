/**
 * GET /api/v1/versao — o build id que este servidor serve.
 *
 * Quem pergunta é a própria tela (`components/app/AvisoDeVersaoNova.tsx`): uma
 * aba aberta durante um deploy compara este valor com o que ela carregou e, se
 * mudou, oferece recarregar.
 *
 * Fica ATRÁS do proxy (não está em `lib/auth/public-paths.ts`): só quem tem
 * sessão pergunta, e o aviso só existe dentro de `/app`. O conteúdo não é
 * segredo nem dado de organização, por isso o handler não consulta banco nem
 * papel — custo de uma leitura de memória. Sem sessão o proxy responde 401, e a
 * tela trata isso como "não sei" (nenhum aviso).
 *
 * `build_id` nulo quando o processo não tem build (ex.: `next dev`).
 */
import { ok } from "@/lib/api/wrappers";
import { identificadorDaVersao } from "@/lib/versao/identificador";

export const dynamic = "force-dynamic";

export function GET() {
  return ok(
    { build_id: identificadorDaVersao() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
