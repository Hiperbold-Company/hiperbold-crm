/**
 * Mensagem agendada (migration 1017): a régua da janela no ato de agendar e na
 * hora do envio, o horário no fuso da organização e a frase do prazo.
 */
import { describe, expect, it } from "vitest";

import { instanteDaParede, paredeDoInstante } from "@/lib/mensagens-agendadas/horario";
import {
  decidirEnvioAgendado,
  exigenciaAoAgendar,
  horarioValido,
  lerModelo,
  PRAZO_MAXIMO_DIAS,
} from "@/lib/mensagens-agendadas/regras";
import { conferirAgendamento } from "@/lib/mensagens-agendadas/servidor";
import { MENSAGEM_HORARIO_INVALIDO } from "@/lib/mensagens-agendadas/textos";

const AGORA = new Date("2026-11-17T12:00:00Z");
const HORA = 60 * 60 * 1000;
const ha = (ms: number) => new Date(AGORA.getTime() - ms).toISOString();
const daqui = (ms: number) => new Date(AGORA.getTime() + ms);
const MODELO = { name: "retomada", language: "pt_BR", values: {}, body: "Oi!" };

describe("no ato de agendar", () => {
  it("oficial com a janela aberta no horário: só o texto basta", () => {
    expect(exigenciaAoAgendar("meta_cloud", ha(1 * HORA), daqui(2 * HORA))).toEqual({ tipo: "livre" });
  });

  it("oficial com a janela que fecha ANTES do horário: modelo obrigatório", () => {
    expect(exigenciaAoAgendar("meta_cloud", ha(20 * HORA), daqui(5 * HORA))).toEqual({ tipo: "modelo_obrigatorio" });
  });

  it("oficial com a janela já fechada (cliente nunca escreveu): modelo obrigatório", () => {
    expect(exigenciaAoAgendar("meta_cloud", null, daqui(HORA))).toEqual({ tipo: "modelo_obrigatorio" });
  });

  it("UAZAPI não tem janela: livre", () => {
    expect(exigenciaAoAgendar("uazapi", null, daqui(48 * HORA))).toEqual({ tipo: "livre" });
  });

  it("Instagram/Messenger fechado e sem modelo no canal: agenda, mas avisa", () => {
    expect(exigenciaAoAgendar("meta_social", ha(30 * HORA), daqui(HORA))).toEqual({ tipo: "sem_saida_fora_da_janela" });
  });

  it("o servidor recusa sem modelo quando ele é obrigatório, e aceita com ele", () => {
    const conversa = { provider: "meta_cloud", last_inbound_at: ha(23 * HORA) };
    expect(conferirAgendamento(conversa, daqui(2 * HORA), null, AGORA)?.codigo).toBe("modelo_obrigatorio");
    expect(conferirAgendamento(conversa, daqui(2 * HORA), MODELO, AGORA)).toBeNull();
  });

  it("modelo num canal que não tem modelo é recusado", () => {
    const conversa = { provider: "uazapi", last_inbound_at: null };
    expect(conferirAgendamento(conversa, daqui(HORA), MODELO, AGORA)?.codigo).toBe("modelo_sem_canal");
  });

  it("horário no passado ou além do prazo é recusado; a frase diz o mesmo número do prazo", () => {
    expect(horarioValido(daqui(-60_000), AGORA)).toBe(false);
    expect(horarioValido(daqui((PRAZO_MAXIMO_DIAS + 1) * 24 * HORA), AGORA)).toBe(false);
    expect(horarioValido(daqui(HORA), AGORA)).toBe(true);
    expect(MENSAGEM_HORARIO_INVALIDO).toContain(`${PRAZO_MAXIMO_DIAS} dias`);
  });

  it("editar só o texto de uma linha cujo horário já passou não é recusado pelo horário", () => {
    const conversa = { provider: "uazapi", last_inbound_at: null };
    expect(conferirAgendamento(conversa, daqui(-HORA), null, AGORA, { conferirHorario: false })).toBeNull();
  });
});

describe("na hora do envio", () => {
  it("janela aberta: texto, mesmo com modelo escolhido", () => {
    expect(decidirEnvioAgendado({ provider: "meta_cloud", lastInboundAt: ha(HORA), agora: AGORA, temModelo: true })).toEqual({
      tipo: "texto",
    });
  });

  it("janela fechada com modelo: modelo", () => {
    expect(decidirEnvioAgendado({ provider: "meta_cloud", lastInboundAt: ha(30 * HORA), agora: AGORA, temModelo: true })).toEqual({
      tipo: "modelo",
    });
  });

  it("janela fechada sem modelo: falha com motivo, nada sai", () => {
    const d = decidirEnvioAgendado({ provider: "meta_cloud", lastInboundAt: ha(30 * HORA), agora: AGORA, temModelo: false });
    expect(d.tipo).toBe("falha");
    expect(d.tipo === "falha" && d.codigo).toBe("janela_fechada_sem_modelo");
  });

  it("canal com janela e sem modelo, fechado: falha legível", () => {
    const d = decidirEnvioAgendado({ provider: "meta_social", lastInboundAt: ha(30 * HORA), agora: AGORA, temModelo: false });
    expect(d.tipo === "falha" && d.codigo).toBe("janela_fechada");
  });

  it("lerModelo não confia na forma do jsonb", () => {
    expect(lerModelo(null)).toBeNull();
    expect(lerModelo(["x"])).toBeNull();
    expect(lerModelo({ name: "a" })).toBeNull();
    expect(lerModelo({ name: "a", language: "pt_BR", values: { "1": "Ana", "2": 3 } })).toEqual({
      name: "a",
      language: "pt_BR",
      values: { "1": "Ana" },
      body: "a",
    });
  });
});

describe("horário no fuso da organização", () => {
  it("14:30 em São Paulo é 17:30 UTC, e volta igual", () => {
    const instante = instanteDaParede("2026-11-18", "14:30", "America/Sao_Paulo");
    expect(instante?.toISOString()).toBe("2026-11-18T17:30:00.000Z");
    expect(paredeDoInstante(instante!, "America/Sao_Paulo")).toEqual({ data: "2026-11-18", hora: "14:30" });
  });

  it("entrada que não é data e hora devolve null", () => {
    expect(instanteDaParede("", "14:30", "America/Sao_Paulo")).toBeNull();
    expect(instanteDaParede("2026-11-18", "25:00", "America/Sao_Paulo")).toBeNull();
  });
});
