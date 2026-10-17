/**
 * Lado do app do batimento (migration 0961): leitura para as rotas
 * `/api/v1/health/worker` e `/api/v1/health/scheduler`, e a escrita do
 * scheduler. A parte pura mora em `batimento.ts`.
 *
 * O scheduler não tem código próprio para bater: ele é o `crond` que chama as
 * rotas de cron do app. Quem bate é o app, quando recebe uma chamada de cron
 * AUTORIZADA (`registrarBatimentoDoScheduler`, chamado pela rota que roda a cada
 * minuto). Sem container novo e sem mexer na imagem do scheduler.
 */
import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  avaliarBatimento,
  criarBatedor,
  type EstadoDoBatimento,
  type ServicoDeFundo,
} from "./batimento";

const TEMPO_MAXIMO_DA_LEITURA_MS = 3_000;

/** Lê o instante do último batimento. Lança se o banco não respondeu. */
export async function lerUltimoBatimento(servico: ServicoDeFundo): Promise<string | null> {
  const consulta = Promise.resolve(
    createAdminClient()
      .from("sistema_batimentos")
      .select("ultimo_em")
      .eq("servico", servico)
      .maybeSingle(),
  );
  let timer: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error("tempo esgotado ao ler o batimento")), TEMPO_MAXIMO_DA_LEITURA_MS);
  });
  try {
    const { data, error } = await Promise.race([consulta, limite]);
    if (error) throw new Error(error.message);
    const ultimo = (data as { ultimo_em?: string } | null)?.ultimo_em;
    return ultimo ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Estado do serviço; leitura que falha vira `down` com motivo próprio (nunca lança). */
export async function estadoDoServico(servico: ServicoDeFundo): Promise<EstadoDoBatimento> {
  try {
    return avaliarBatimento(servico, await lerUltimoBatimento(servico));
  } catch (err) {
    logger.warn("[batimento] leitura indisponível", {
      servico,
      error: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return { status: "down", ultimo_batimento_em: null, segundos_desde: null, motivo: "leitura_indisponivel" };
  }
}

/**
 * A resposta das rotas de saúde por serviço: pública, sem segredo e sem dado de
 * organização, nunca em cache. 200 quando o batimento é recente, 503 quando não.
 */
export async function responderSaudeDoServico(servico: ServicoDeFundo): Promise<NextResponse> {
  const estado = await estadoDoServico(servico);
  return NextResponse.json(estado, {
    status: estado.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

const batedorDoScheduler = criarBatedor({
  gravar: async () => {
    const { error } = await createAdminClient()
      .from("sistema_batimentos")
      .upsert(
        {
          servico: "scheduler",
          ultimo_em: new Date().toISOString(),
          versao: process.env.APP_VERSION || null,
        },
        { onConflict: "servico" },
      );
    if (error) throw new Error(error.message);
  },
  aoFalhar: (err) =>
    logger.warn("[batimento] scheduler não gravado", {
      error: err instanceof Error ? err.message.slice(0, 200) : "erro",
    }),
});

/**
 * Chame DEPOIS de `autorizaCron(req)` ter aprovado. Não espera a escrita e nunca
 * lança: a resposta do cron não depende do batimento.
 */
export function registrarBatimentoDoScheduler(): void {
  try {
    batedorDoScheduler.tocar();
  } catch {
    /* batimento é observabilidade; jamais derruba o cron */
  }
}
