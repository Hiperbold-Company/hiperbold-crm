import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

/**
 * A DURAÇÃO DO ÁUDIO É A BASE DO DÉBITO NO PLANO (migration 1025).
 *
 * A transcrição desconta 6.000 tokens por minuto de áudio quando sai pela
 * chave da instalação. O banco só debita o que chega em
 * `llm_calls.audio_seconds`, e quem traz a duração é a resposta do serviço:
 * `usage.seconds` (OpenRouter), `usage: { type: "duration", seconds }` ou
 * `duration` no topo (`verbose_json` do `whisper-1`). Sem nenhum dos três, a
 * duração é desconhecida (null) e a transcrição não debita — nunca uma
 * estimativa pelo tamanho do arquivo.
 */

function resposta(corpo: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

const AUDIO = Buffer.from([1, 2, 3]);

describe("a transcrição devolve a duração que o serviço informou", () => {
  it("OpenRouter: `usage.seconds` vem junto do custo", async () => {
    const provedor = apiTranscriptionProvider(
      { apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", medirCustoEmUsd: true },
      resposta({ text: "olá", usage: { seconds: 42.5, cost: 0.0005 } }),
    );
    const medido = await provedor.transcribeMedindo!(AUDIO, "audio/ogg");
    expect(medido.segundos).toBe(42.5);
  });

  it("OpenRouter sem `usage.seconds`: duração desconhecida (null)", async () => {
    const provedor = apiTranscriptionProvider(
      { apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", medirCustoEmUsd: true },
      resposta({ text: "olá", usage: { cost: 0.0005 } }),
    );
    expect((await provedor.transcribeMedindo!(AUDIO, "audio/ogg")).segundos).toBeNull();
  });

  it("whisper-1 na OpenAI: `duration` do verbose_json", async () => {
    const provedor = apiTranscriptionProvider({ apiKey: "sk-test" }, resposta({ text: "olá", duration: 30 }));
    expect((await provedor.transcribeMedindo!(AUDIO, "audio/ogg")).segundos).toBe(30);
  });

  it("duração negativa ou não numérica é descartada", async () => {
    const provedor = apiTranscriptionProvider(
      { apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", medirCustoEmUsd: true },
      resposta({ text: "olá", usage: { seconds: -3, cost: 0.0005 } }),
    );
    expect((await provedor.transcribeMedindo!(AUDIO, "audio/ogg")).segundos).toBeNull();
  });
});
