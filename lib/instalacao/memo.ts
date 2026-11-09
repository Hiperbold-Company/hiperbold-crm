/**
 * O prazo do memo de processo da CONFIGURAÇÃO DA INSTALAÇÃO (`platform_config`):
 * `lib/instalacao/config.ts` (as chaves) e `lib/instalacao/modulos.ts` (os
 * interruptores de módulo). O mecanismo é o `comCacheCurto` de
 * `lib/auth/cache-curto.ts`; aqui só mora o prazo.
 *
 * Padrão: `TTL_CURTO_MS` (30 s). `MEMO_DA_INSTALACAO_MS=0` desliga o memo — existe
 * para o servidor do e2e, cujas specs ligam e desligam módulo escrevendo direto
 * no banco, de OUTRO processo (o Playwright), caminho que nenhuma invalidação em
 * processo alcança. Produção não define a variável.
 */
import { TTL_CURTO_MS } from "@/lib/auth/cache-curto";

export function ttlDoMemoDaInstalacaoMs(): number {
  const bruto = process.env.MEMO_DA_INSTALACAO_MS;
  if (bruto === undefined || bruto.trim() === "") return TTL_CURTO_MS;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : TTL_CURTO_MS;
}
