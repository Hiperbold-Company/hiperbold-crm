/**
 * O PORTÃO DO PISO OCIOSO (#3731, parte 1) — o que ele promete, medido.
 *
 * As três promessas, uma por teste:
 *
 * 1. UMA consulta responde pelos CINCO recursos (não uma por recurso).
 * 2. CEM ticks dentro da janela continuam sendo UMA consulta — o portão não pode
 *    virar a consulta por minuto que ele veio remover.
 * 3. Leitura que falha = "tem trabalho" (a rota segue), e a falha também fica em
 *    cache: um banco quebrado não pode transformar o portão em enxurrada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TRAVADA_APOS_MS } from "@/lib/channels/meta-social/fila";
import { ROUTING_EVENT_TYPE } from "@/lib/routing/worker";

import {
  type BancoDoPortao,
  esquecerRetrato,
  invalidarRetrato,
  organizacoesComHistorico,
  RECURSOS_DO_CRON,
  recursoOcioso,
  recursoTemTrabalho,
  TTL_DO_RETRATO_MS,
} from "./piso-ocioso";

type ConsultaDublada = (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;

/** Pool de mentira: conta consultas e devolve a linha que o teste mandar. */
function banco(linha: Record<string, unknown> = {}) {
  const consultas: string[] = [];
  const query = vi.fn<ConsultaDublada>(async (sql: string) => {
    consultas.push(sql);
    return { rows: [linha], rowCount: 1 };
  });
  // O `Pool["query"]` do pg é sobrecarregado (callback/evento); o portão só usa a
  // forma que devolve promessa, então o dublê entra como banco por este tipo.
  const portao = { query } as unknown as BancoDoPortao;
  return { consultas, query, portao };
}

const TUDO_VAZIO = {
  prospeccao: false,
  campanhas: false,
  historico: false,
  agenda_google: false,
  agenda_google_push: false,
};

beforeEach(() => {
  esquecerRetrato();
  vi.restoreAllMocks();
});

describe("portão do piso ocioso", () => {
  it("o sinal do histórico também olha a recuperação de queda (Spec 32), não só a importação rodando", async () => {
    // Sem isto a rota sairia antes de abrir a recuperação: uma queda do número numa
    // instalação sem importação alguma nunca recuperaria nada.
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("historico", 1_000, db.portao);
    const sql = (db.consultas[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain("importacoes_de_historico where status in ('rodando', 'aguardando')");
    expect(sql).toContain("event_type = 'channel_session.status_changed'");
    expect(sql).toContain("payload ->> 'from_status' = 'WORKING'");
    expect(sql).toContain("kind in ('recuperacao_da_queda', 'cliente_sem_resposta_na_queda')");
  });

  it("uma consulta responde por todos os recursos", async () => {
    const db = banco(TUDO_VAZIO);
    const respostas = await Promise.all(
      RECURSOS_DO_CRON.map((recurso) => recursoTemTrabalho(recurso, 1_000, db.portao)),
    );
    expect(respostas).toEqual(RECURSOS_DO_CRON.map(() => false));
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("cada coluna vira o recurso dela (controle positivo: nem tudo é falso)", async () => {
    const db = banco({
      prospeccao: true,
      campanhas: false,
      historico: true,
      agenda_google: false,
      agenda_google_push: true,
    });
    expect(await recursoTemTrabalho("prospeccao", 1_000, db.portao)).toBe(true);
    expect(await recursoTemTrabalho("historico", 1_000, db.portao)).toBe(true);
    expect(await recursoOcioso("campanhas", 1_000, db.portao)).toBe(true);
    expect(await recursoOcioso("agenda_google", 1_000, db.portao)).toBe(true);
    expect(await recursoTemTrabalho("agenda_google_push", 1_000, db.portao)).toBe(true);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("⭐ 100 ticks dentro da janela = 1 consulta (não é uma por minuto)", async () => {
    const db = banco(TUDO_VAZIO);
    // 100 ticks do cron de minuto a minuto, todos dentro do mesmo retrato.
    for (let tick = 0; tick < 100; tick++) {
      expect(await recursoOcioso("prospeccao", 1_000, db.portao)).toBe(true);
    }
    expect(db.query).toHaveBeenCalledOnce();

    // Passada a janela, o retrato é refeito UMA vez.
    await recursoTemTrabalho("prospeccao", 1_000 + TTL_DO_RETRATO_MS + 1, db.portao);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("leitura que falha = 'tem trabalho', e a falha fica em cache", async () => {
    const query = vi.fn<ConsultaDublada>(async () => {
      throw new Error("relation does not exist");
    });
    const portao = { query } as unknown as BancoDoPortao;
    for (let tick = 0; tick < 100; tick++) {
      expect(await recursoTemTrabalho("prospeccao", 1_000, portao)).toBe(true);
    }
    expect(query).toHaveBeenCalledOnce();
  });

  it("pool indisponível (sem SUPABASE_DB_URL) não derruba a rota: ela roda", async () => {
    // Sem `db`, o portão chama getRequestPool(), que lança sem a variável — o
    // caso do ambiente de teste. A rota tem de seguir o caminho normal.
    expect(await recursoTemTrabalho("historico")).toBe(true);
  });

  it("retrato velho não vale: quem ligou o recurso é atendido no tick seguinte à janela", async () => {
    const vazio = banco(TUDO_VAZIO);
    expect(await recursoTemTrabalho("campanhas", 1_000, vazio.portao)).toBe(false);

    const comCampanha = banco({ ...TUDO_VAZIO, campanhas: true });
    expect(
      await recursoTemTrabalho("campanhas", 1_000 + TTL_DO_RETRATO_MS + 1, comCampanha.portao),
    ).toBe(true);
  });

  it("⭐ campanha ligada logo depois de um retrato vazio: a batida do minuto seguinte já roda", async () => {
    // O crond dispara tudo no segundo 0. Retrato lido vazio em t=0, a pessoa
    // clica "Iniciar" em t=1 s, a batida seguinte chega em t=60 s. Com o TTL de
    // 5 min que este portão tinha, essa batida (e as três seguintes) PULAVA.
    const vazio = banco(TUDO_VAZIO);
    expect(await recursoOcioso("campanhas", 0, vazio.portao)).toBe(true);

    const comCampanha = banco({ ...TUDO_VAZIO, campanhas: true });
    expect(await recursoOcioso("campanhas", 60_000, comCampanha.portao)).toBe(false);
    expect(comCampanha.query).toHaveBeenCalledOnce();
  });

  it("cada recurso tem a sua coluna na consulta (sem coluna, o recurso viveria desligado)", async () => {
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("followup", 1_000, db.portao);
    for (const recurso of RECURSOS_DO_CRON) {
      expect(db.consultas[0], `coluna '${recurso}' ausente do retrato`).toMatch(new RegExp(`\\) as ${recurso}\\b`));
    }
  });

  it("⭐ invalidar faz a batida seguinte reler, dentro da mesma janela (#3694)", async () => {
    const vazio = banco(TUDO_VAZIO);
    expect(await recursoTemTrabalho("followup", 1_000, vazio.portao)).toBe(false);

    invalidarRetrato();
    const comInscricao = banco({ ...TUDO_VAZIO, followup: true });
    expect(await recursoTemTrabalho("followup", 1_001, comInscricao.portao)).toBe(true);
    expect(comInscricao.query).toHaveBeenCalledOnce();
  });

  it("a leitura que estava em voo quando alguém invalidou não grava o retrato velho", async () => {
    let soltar: (v: { rows: unknown[]; rowCount: number }) => void = () => {};
    const lenta = { query: () => new Promise((r) => (soltar = r)) } as unknown as BancoDoPortao;
    const emVoo = recursoTemTrabalho("followup", 1_000, lenta);

    invalidarRetrato();
    soltar({ rows: [TUDO_VAZIO], rowCount: 1 });
    expect(await emVoo).toBe(false);

    const comInscricao = banco({ ...TUDO_VAZIO, followup: true });
    expect(await recursoTemTrabalho("followup", 1_001, comInscricao.portao)).toBe(true);
  });

  it("o sinal do follow-up anda junto com o claim que ele poupa (sinal mais estreito cala o motor)", async () => {
    // Mais LARGO é inofensivo: só paga a consulta que já se pagava. Mais ESTREITO
    // para de reclamar inscrição vencida sem erro nenhum — a rota devolve 200.
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("followup", 1_000, db.portao);
    const sql = db.consultas[0] ?? "";
    const sinal = sql.slice(sql.indexOf("from followup_enrollments"), sql.indexOf(") as followup,"));

    const baseline = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    const inicio = baseline.lastIndexOf("create or replace function fn_claim_due_followup_enrollments");
    expect(inicio).toBeGreaterThan(0);
    const claim = baseline.slice(inicio, baseline.indexOf("$$;", inicio));

    expect(/organizations/.test(sinal), "sinal e claim discordam sobre a organização operante").toBe(
      /organizations/.test(claim),
    );
    const semEspaco = (texto: string) => texto.replace(/\s+/g, "");
    for (const condicao of ["'active','waiting_reply','dormente'", "next_eval_at<=now()", "claimed_until"]) {
      expect(semEspaco(claim)).toContain(condicao);
      expect(semEspaco(sinal)).toContain(condicao);
    }
  });
});

describe("as rotinas de minuto (terceira fatia): o sinal anda junto com o que a rotina faz", () => {
  const semEspaco = (texto: string) => texto.replace(/\s+/g, "");
  const baseline = () => readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");

  it("confirmação de presença: as condições da última definição de fn_appointment_confirmation_sweep estão no sinal", async () => {
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("confirmacao_de_presenca", 1_000, db.portao);
    const sinal = semEspaco(db.consultas[0] ?? "");

    const arquivo = baseline();
    const inicio = arquivo.lastIndexOf("create or replace function public.fn_appointment_confirmation_sweep");
    expect(inicio).toBeGreaterThan(0);
    const funcao = semEspaco(arquivo.slice(inicio, arquivo.indexOf("$$;", arquivo.indexOf("$$", inicio) + 2)));

    // Cada condição da função (menos o atraso por organização, que só estreita)
    // tem de estar no sinal; sinal mais ESTREITO calaria a confirmação sem erro.
    expect(funcao).toContain("c.statusin('pending','confirmed')");
    expect(sinal).toContain("c.statusin('pending','confirmed')");
    expect(funcao).toContain("(c.confirmation_next_atisnullorc.confirmation_next_at<=p_now)");
    expect(sinal).toContain("(c.confirmation_next_atisnullorc.confirmation_next_at<=now())");
    expect(funcao).toContain("ct.is_anonymized");
    expect(sinal).toContain("ct.is_anonymized");
    // O atraso de confirmação nunca é menor que 1 minuto (fn_agenda_minutes), então
    // `ends_at <= now()` é um superconjunto de `ends_at + atraso <= now()`.
    expect(funcao).toContain("c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now");
    expect(sinal).toContain("c.ends_at<=now()");
  });

  it("fila da Meta: a vencida (select da rodada) e a travada (destravar) ligam o recurso, com folga no prazo da travada", async () => {
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("fila_meta_social", 1_000, db.portao);
    const sql = (db.consultas[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain("meta_social_fila_de_envio where status = 'na_fila' and proxima_tentativa_em <= now()");
    const travada = /meta_social_fila_de_envio where status = 'enviando' and atualizado_em < now\(\) - interval '(\d+) minutes'/.exec(sql);
    expect(travada, "o piso não olha a linha `enviando` parada").not.toBeNull();
    // Mais CEDO que a rodada (que espera TRAVADA_APOS_MS): nunca mais tarde.
    expect(Number(travada![1]) * 60_000).toBeLessThanOrEqual(TRAVADA_APOS_MS);
  });

  it("roteamento: o tipo do evento é o do worker e os dois estados (pendente e processando) ligam o recurso", async () => {
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("roteamento", 1_000, db.portao);
    const sql = (db.consultas[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain(`event_type = '${ROUTING_EVENT_TYPE}' and status in ('pending', 'processing')`);
  });

  it("cada coluna nova liga só o seu recurso", async () => {
    const db = banco({ ...TUDO_VAZIO, fila_meta_social: true });
    expect(await recursoTemTrabalho("fila_meta_social", 1_000, db.portao)).toBe(true);
    expect(await recursoTemTrabalho("roteamento", 1_000, db.portao)).toBe(false);
    expect(await recursoTemTrabalho("confirmacao_de_presenca", 1_000, db.portao)).toBe(false);
  });
});

describe("organizacoesComHistorico — a lista que poupa o laço por organização", () => {
  it("devolve os organization_id da consulta, em UMA ida ao banco", async () => {
    const consultas: string[] = [];
    const portao = {
      query: vi.fn<ConsultaDublada>(async (sql: string) => {
        consultas.push(sql);
        return { rows: [{ organization_id: "org-a" }, { organization_id: "org-b" }], rowCount: 2 };
      }),
    } as unknown as BancoDoPortao;
    expect(await organizacoesComHistorico(portao)).toEqual(["org-a", "org-b"]);
    expect(consultas).toHaveLength(1);
  });

  it("lista vazia é resposta de verdade (ninguém tem o que olhar), não falha", async () => {
    const portao = { query: vi.fn<ConsultaDublada>(async () => ({ rows: [], rowCount: 0 })) } as unknown as BancoDoPortao;
    expect(await organizacoesComHistorico(portao)).toEqual([]);
  });

  it("erro do banco = null (quem chama olha todas as operantes)", async () => {
    const portao = {
      query: vi.fn<ConsultaDublada>(async () => {
        throw new Error("relation does not exist");
      }),
    } as unknown as BancoDoPortao;
    expect(await organizacoesComHistorico(portao)).toBeNull();
  });

  it("pool indisponível (sem SUPABASE_DB_URL) = null", async () => {
    expect(await organizacoesComHistorico()).toBeNull();
  });

  it("as três condições são as do recurso `historico` e só entra organização operante", async () => {
    const lista = banco({});
    await organizacoesComHistorico(lista.portao);
    const sqlDaLista = (lista.consultas[0] ?? "").replace(/\s+/g, " ");

    const retrato = banco(TUDO_VAZIO);
    await recursoTemTrabalho("historico", 1_000, retrato.portao);
    const sqlDoRetrato = (retrato.consultas[0] ?? "").replace(/\s+/g, " ");

    for (const condicao of [
      "importacoes_de_historico where status in ('rodando', 'aguardando')",
      "event_type = 'channel_session.status_changed' and payload ->> 'from_status' = 'WORKING' and created_at > now() - interval '8 days'",
      "status = 'open' and kind in ('recuperacao_da_queda', 'cliente_sem_resposta_na_queda')",
    ]) {
      expect(sqlDoRetrato, `o retrato perdeu: ${condicao}`).toContain(condicao);
      expect(sqlDaLista, `a lista perdeu: ${condicao}`).toContain(condicao);
    }
    expect(sqlDaLista).toContain("o.status = 'active'");
  });
});
