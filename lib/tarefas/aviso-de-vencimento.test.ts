import { describe, expect, it } from "vitest";

import {
  avisoAindaVale,
  avisosNovos,
  chaveDoAviso,
  destinatariosDoAviso,
  destinoDaTarefa,
} from "./aviso-de-vencimento";

const ROSANA = "11111111-1111-4000-8000-000000000001";
const BETO = "11111111-1111-4000-8000-000000000002";

describe("destinatariosDoAviso", () => {
  it("quem criou e o responsável, cada um uma vez", () => {
    expect(destinatariosDoAviso({ created_by: ROSANA, assigned_to: BETO })).toEqual([ROSANA, BETO]);
  });

  it("quem marca para si mesmo recebe um aviso só", () => {
    expect(destinatariosDoAviso({ created_by: ROSANA, assigned_to: ROSANA })).toEqual([ROSANA]);
  });

  it("sem responsável, só quem criou; sem ninguém, ninguém", () => {
    expect(destinatariosDoAviso({ created_by: ROSANA, assigned_to: null })).toEqual([ROSANA]);
    expect(destinatariosDoAviso({ created_by: null, assigned_to: null })).toEqual([]);
  });
});

describe("destinoDaTarefa", () => {
  it("leva ao negócio dentro do funil, como o «Abrir negócio» da Central", () => {
    expect(destinoDaTarefa("lead-1", "funil-1")).toBe("/app/pipelines/funil-1?lead=lead-1");
  });

  it("sem negócio ou sem funil visível, a tela de Tarefas", () => {
    expect(destinoDaTarefa(null, null)).toBe("/app/tasks");
    expect(destinoDaTarefa("lead-1", null)).toBe("/app/tasks");
  });
});

describe("avisoAindaVale", () => {
  const prazo = "2026-11-03T13:00:00.000Z"; // 03/11 às 10:00 em São Paulo

  it("vale para a tarefa aberta com o mesmo prazo, escrito de outra forma", () => {
    expect(avisoAindaVale({ status: "pending", due_date: "2026-11-03 13:00:00+00" }, prazo)).toBe(true);
    expect(avisoAindaVale({ status: "in_progress", due_date: "2026-11-03T10:00:00-03:00" }, prazo)).toBe(true);
  });

  it("não vale se ela foi concluída ou cancelada antes de o push sair", () => {
    expect(avisoAindaVale({ status: "done", due_date: prazo }, prazo)).toBe(false);
    expect(avisoAindaVale({ status: "cancelled", due_date: prazo }, prazo)).toBe(false);
  });

  it("não vale se o prazo foi remarcado (o aviso do novo prazo é outro)", () => {
    expect(avisoAindaVale({ status: "pending", due_date: "2026-11-05T13:00:00.000Z" }, prazo)).toBe(false);
    expect(avisoAindaVale({ status: "pending", due_date: null }, prazo)).toBe(false);
  });
});

describe("avisosNovos (o toast do sino)", () => {
  const agora = new Date("2026-11-03T13:00:30.000Z");
  const DIA = 24 * 60 * 60 * 1000;
  const venceuAgora = { id: "t1", due_date: "2026-11-03T13:00:00.000Z" };
  const antiga = { id: "t2", due_date: "2026-10-20T13:00:00.000Z" };
  const futura = { id: "t3", due_date: "2026-11-03T14:00:00.000Z" };

  it("avisa a que acabou de vencer, não a antiga nem a futura", () => {
    expect(avisosNovos([venceuAgora, antiga, futura], new Set(), agora, DIA)).toEqual([venceuAgora]);
  });

  it("não repete o aviso já dado neste navegador", () => {
    expect(avisosNovos([venceuAgora], new Set([chaveDoAviso(venceuAgora)]), agora, DIA)).toEqual([]);
  });

  it("remarcar rearma: a chave é tarefa + prazo", () => {
    const remarcada = { id: "t1", due_date: "2026-11-03T12:59:00.000Z" };
    expect(avisosNovos([remarcada], new Set([chaveDoAviso(venceuAgora)]), agora, DIA)).toEqual([remarcada]);
  });
});
