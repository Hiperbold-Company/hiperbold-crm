import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * A TRANSCRIÇÃO DE ÁUDIO DESCONTA TOKENS DO PLANO (migration 1025).
 *
 * Decisão do dono do produto (25/11/2026): 6.000 tokens por minuto de áudio,
 * proporcional aos segundos e arredondado para cima, só quando a transcrição
 * saiu pela chave da INSTALAÇÃO — a mesma régua das outras chamadas de IA. A
 * linha de transcrição em `llm_calls` tem 0 tokens (o serviço cobra por
 * minuto), e por isso o débito pondera pela duração gravada em
 * `llm_calls.audio_seconds`.
 *
 * O que estes casos fixam, sempre lendo o livro-caixa e o agregado que o
 * extrato de Meu plano soma (nunca a função por dentro):
 *  1. 90,5 s com a chave da instalação = ceil(90,5 / 60 * 6000) = 9.050;
 *     1 s = 100; e o agregado do dia leva a linha sem agente;
 *  2. a mesma transcrição com a credencial da organização não debita;
 *  3. transcrição que falhou (status erro) ou sem duração conhecida não debita;
 *  4. a duração só vale para a transcrição: outro propósito segue pelos tokens;
 *  5. isolamento entre duas organizações: o débito de A cai só na carteira de
 *     A, e o gerente de A não lê o consumo de B;
 *  6. o conferidor (`fn_billing_debitos_pendentes`) acha a transcrição que o
 *     gatilho não debitou e a debita com o mesmo valor.
 */

const ORG_INSTALACAO = "10250000-0000-4000-8000-000000000001";
const ORG_CREDENCIAL = "10250000-0000-4000-8000-000000000002";
const ORG_SEM_DEBITO = "10250000-0000-4000-8000-000000000003";
const ORG_OUTRO_PROPOSITO = "10250000-0000-4000-8000-000000000004";
const ORG_ISO_A = "10250000-0000-4000-8000-000000000005";
const ORG_ISO_B = "10250000-0000-4000-8000-000000000006";
const USER_ISO_A_MANAGER = "10250000-1111-4000-8000-000000000001";
const ORG_PENDENTE = "10250000-0000-4000-8000-000000000007";

const MARCA = "SONDA|";

function comoServico(corpo: string): string[] {
  return sql(corpo)
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;
    select public.fn_billing_ajustar_limites('${id}'::uuid, '{"tokens_ia_mes": 1000000}'::jsonb, null, null);`;
}

function transcricao(
  org: string,
  model: string,
  segundos: number | null,
  opts: { origem?: string; status?: "ok" | "erro"; purpose?: string; outputTokens?: number } = {},
): string {
  const seg = segundos === null ? "null" : String(segundos);
  return `insert into public.llm_calls
    (organization_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, origem_da_chave, status, audio_seconds)
    values ('${org}', '${opts.purpose ?? "transcricao_de_audio"}', 'openrouter', '${model}', 0, ${opts.outputTokens ?? 0}, 0,
      '${opts.origem ?? "chave_da_instalacao"}', '${opts.status ?? "ok"}', ${seg});`;
}

function debitoDaChamada(model: string): number {
  return Number(
    comoServico(
      `select 'SONDA|' || coalesce(-sum(l.tokens), 0) from public.billing_token_ledger l
        join public.llm_calls c on c.id = l.llm_call_id and c.organization_id = l.organization_id
        where c.model = '${model}' and l.chave like 'consumo:%';`,
    )[0],
  );
}

function linhasDeConsumoDe(org: string): number {
  return Number(
    comoServico(
      `select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${org}' and chave like 'consumo:%';`,
    )[0],
  );
}

describe("1. Transcrição pela chave da instalação desconta 6.000 tokens por minuto, arredondado para cima", () => {
  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_INSTALACAO, "transcricao-instalacao")}
      ${transcricao(ORG_INSTALACAO, "t-90-5", 90.5)}
      ${transcricao(ORG_INSTALACAO, "t-1", 1)}
      ${transcricao(ORG_INSTALACAO, "t-12-34", 12.34)}
    `);
  });

  it("90,5 s = 9.050 tokens", () => {
    expect(debitoDaChamada("t-90-5")).toBe(9050);
  });

  it("1 s = 100 tokens, e 12,34 s = 1.234 (fração de segundo arredonda para cima no total)", () => {
    expect(debitoDaChamada("t-1")).toBe(100);
    expect(debitoDaChamada("t-12-34")).toBe(1234);
  });

  it("o agregado do extrato (por dia) soma a transcrição sem agente, no propósito transcricao_de_audio", () => {
    expect(
      comoServico(
        `select 'SONDA|' || coalesce(agent_id::text, 'sem_agente') || '|' || tokens_ponderados || '|' || chamadas
          from public.billing_token_consumo_diario
          where organization_id = '${ORG_INSTALACAO}' and purpose = 'transcricao_de_audio';`,
      ),
    ).toEqual(["sem_agente|10384|3"]);
  });
});

describe("2. Com a credencial da própria organização, a transcrição não desconta nada", () => {
  it("nenhuma linha de consumo nasce", () => {
    comoServico(`
      ${criarOrgSql(ORG_CREDENCIAL, "transcricao-credencial")}
      ${transcricao(ORG_CREDENCIAL, "t-credencial", 120, { origem: "credencial_da_organizacao" })}
    `);
    expect(linhasDeConsumoDe(ORG_CREDENCIAL)).toBe(0);
  });
});

describe("3. Transcrição que falhou, ou sem duração conhecida, não desconta", () => {
  it("status erro com duração não debita, e duração nula ou zero não debita", () => {
    comoServico(`
      ${criarOrgSql(ORG_SEM_DEBITO, "transcricao-sem-debito")}
      ${transcricao(ORG_SEM_DEBITO, "t-erro", 60, { status: "erro" })}
      ${transcricao(ORG_SEM_DEBITO, "t-nula", null)}
      ${transcricao(ORG_SEM_DEBITO, "t-zero", 0)}
    `);
    expect(linhasDeConsumoDe(ORG_SEM_DEBITO)).toBe(0);
  });
});

describe("4. A duração só vale para a transcrição; outro propósito continua pelos tokens", () => {
  it("agent_turn com audio_seconds preenchido debita só os tokens", () => {
    comoServico(`
      ${criarOrgSql(ORG_OUTRO_PROPOSITO, "transcricao-outro-proposito")}
      ${transcricao(ORG_OUTRO_PROPOSITO, "t-turno", 60, { purpose: "agent_turn", outputTokens: 42 })}
    `);
    expect(debitoDaChamada("t-turno")).toBe(42);
  });
});

describe("5. Isolamento entre duas organizações", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_ISO_A_MANAGER}', 'transcricao-gerente-a@invariant.test')
        on conflict (id) do nothing;
      ${criarOrgSql(ORG_ISO_A, "transcricao-iso-a")}
      ${criarOrgSql(ORG_ISO_B, "transcricao-iso-b")}
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_ISO_A_MANAGER}', '${ORG_ISO_A}', 'manager', now()) on conflict do nothing;
      ${transcricao(ORG_ISO_A, "t-iso-a", 30)}
      ${transcricao(ORG_ISO_B, "t-iso-b", 60)}
    `);
  });

  it("cada carteira leva só o débito da própria organização", () => {
    const consumido = (org: string) =>
      comoServico(
        `select 'SONDA|' || coalesce(sum(consumido), 0) from public.billing_token_wallets where organization_id = '${org}';`,
      )[0];
    expect(consumido(ORG_ISO_A)).toBe("3000");
    expect(consumido(ORG_ISO_B)).toBe("6000");
  });

  it("o gerente de A lê o consumo de transcrição de A e nada de B", () => {
    const ler = (org: string) =>
      comoServico(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${USER_ISO_A_MANAGER}"}', false);
        select 'SONDA|' || count(*) from public.billing_token_consumo_diario
          where organization_id = '${org}' and purpose = 'transcricao_de_audio';
      `)[0];
    expect(ler(ORG_ISO_A)).toBe("1");
    expect(ler(ORG_ISO_B)).toBe("0");
  });
});

describe("6. O conferidor acha a transcrição que o gatilho não debitou", () => {
  it("aparece em fn_billing_debitos_pendentes e é debitada com o mesmo valor", () => {
    // `session_replication_role = replica` desliga os gatilhos SÓ nesta sessão
    // psql: é o caso da trava ocupada, em que o gatilho desiste e deixa a
    // chamada para o conferidor.
    comoServico(`
      ${criarOrgSql(ORG_PENDENTE, "transcricao-pendente")}
      set session_replication_role = replica;
      ${transcricao(ORG_PENDENTE, "t-pendente", 45)}
    `);
    expect(linhasDeConsumoDe(ORG_PENDENTE)).toBe(0);
    expect(
      comoServico(
        `select 'SONDA|' || count(*) from public.fn_billing_debitos_pendentes('${ORG_PENDENTE}'::uuid) p
          join public.llm_calls c on c.id = p where c.model = 't-pendente';`,
      ),
    ).toEqual(["1"]);
    comoServico(
      `select 'SONDA|' || public.fn_billing_debitar_chamada(p) from public.fn_billing_debitos_pendentes('${ORG_PENDENTE}'::uuid) p;`,
    );
    expect(debitoDaChamada("t-pendente")).toBe(4500);
  });
});
