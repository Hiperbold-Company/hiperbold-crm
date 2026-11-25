import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

/**
 * A TRANSCRIÇÃO PELO `whisper-1` DA OPENAI GRAVAVA CUSTO NULO.
 *
 * Medido na produção (llm_calls, 30 dias até 25/11/2026): 190 linhas numa
 * organização e 113 noutra com `purpose = transcricao_de_audio`,
 * `model = whisper-1`, chave da instalação, tokens 0 e `cost_cents` nulo. O
 * Whisper cobra por MINUTO de áudio (US$ 0,006/min), e o provedor só expunha
 * `transcribeMedindo` — o caminho que devolve custo ao worker
 * (`comCustoRegistrado`, `workers/media-derive-worker.ts`) — para a OpenRouter.
 * Para a OpenAI nada media a duração, então o teto de gasto não via o áudio.
 *
 * O que estes casos fixam: na API da OpenAI, `whisper-1` pede `verbose_json`
 * (que traz `duration`) e o custo sai da duração; qualquer outro endereço ou
 * modelo segue sem custo (null, nunca 0) e sem mudar o formato da chamada.
 */

function resposta(corpo: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

const AUDIO = Buffer.from([1, 2, 3]);

describe("whisper-1 na API da OpenAI: custo pela duração do áudio", () => {
  it("30 s de áudio custam 0,3 centavo (US$ 0,006 por minuto)", async () => {
    const fetchMock = resposta({ text: "olá", duration: 30 });
    const provedor = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    expect(provedor.transcribeMedindo, "sem medição o worker grava custo nulo").toBeDefined();
    const medido = await provedor.transcribeMedindo!(AUDIO, "audio/ogg");
    expect(medido.texto).toBe("olá");
    expect(medido.custoCents).toBeCloseTo(0.3, 10);
    expect((fetchMock.mock.calls[0]![1].body as FormData).get("response_format")).toBe("verbose_json");
  });

  it("aceita a duração em `usage: { type: 'duration', seconds }`", async () => {
    const fetchMock = resposta({ text: "olá", usage: { type: "duration", seconds: 90 } });
    const provedor = apiTranscriptionProvider({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" }, fetchMock);
    const medido = await provedor.transcribeMedindo!(AUDIO, "audio/ogg");
    expect(medido.custoCents).toBeCloseTo(0.9, 10);
  });

  it("sem duração na resposta, o custo é desconhecido (null), nunca zero", async () => {
    const provedor = apiTranscriptionProvider({ apiKey: "sk-test" }, resposta({ text: "olá" }));
    const medido = await provedor.transcribeMedindo!(AUDIO, "audio/ogg");
    expect(medido.custoCents).toBeNull();
  });
});

describe("fora do whisper-1 da OpenAI, nada muda", () => {
  it("whisper-1 em outro endereço (serviço próprio, Groq): formato padrão e sem custo", async () => {
    const fetchMock = resposta({ text: "olá", duration: 30 });
    const provedor = apiTranscriptionProvider(
      { apiKey: "sk-test", baseUrl: "https://api.groq.com/openai/v1" },
      fetchMock,
    );
    expect(await provedor.transcribe(AUDIO, "audio/ogg")).toBe("olá");
    expect((fetchMock.mock.calls[0]![1].body as FormData).has("response_format")).toBe(false);
    const medido = provedor.transcribeMedindo ? await provedor.transcribeMedindo(AUDIO, "audio/ogg") : null;
    expect(medido?.custoCents ?? null).toBeNull();
  });

  it("gpt-4o-transcribe (cobrado por token) não pede verbose_json nem ganha tarifa por minuto", async () => {
    const fetchMock = resposta({ text: "olá", usage: { type: "duration", seconds: 30 } });
    const provedor = apiTranscriptionProvider({ apiKey: "sk-test", model: "gpt-4o-transcribe" }, fetchMock);
    await provedor.transcribe(AUDIO, "audio/ogg");
    expect((fetchMock.mock.calls[0]![1].body as FormData).has("response_format")).toBe(false);
    const medido = provedor.transcribeMedindo ? await provedor.transcribeMedindo(AUDIO, "audio/ogg") : null;
    expect(medido?.custoCents ?? null).toBeNull();
  });

  it("OpenRouter segue com o custo em USD que ela informa", async () => {
    const fetchMock = resposta({ text: "olá", usage: { cost: 0.0005 } });
    const provedor = apiTranscriptionProvider(
      { apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", medirCustoEmUsd: true },
      fetchMock,
    );
    const medido = await provedor.transcribeMedindo!(AUDIO, "audio/ogg");
    expect(medido.custoCents).toBeCloseTo(0.05, 10);
    expect((fetchMock.mock.calls[0]![1].body as FormData).has("response_format")).toBe(false);
  });
});
