import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  GOV_VIEWER,
  seedGov,
  sql,
} from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 0743 (#3286) — `lead.date_field_due` é do servidor.
 *
 * Desde a 0743 o gatilho de data do funil alcança a origem do atendimento e a
 * ação de WhatsApp envia. Quem o emite é só o cron `lead-date-field-due`, pelo
 * admin client (sem `auth.uid()`). O tipo entra na mesma lista do `emit_event`
 * que já guarda `contact.birthday` (0551) e `contact.phone_added` (0670).
 */

// Contato e negócio próprios: os do seed são mexidos por outros arquivos.
const CONTATO = "cccccccc-3333-4000-8000-000000003286";
const NEGOCIO = "cccccccc-6666-4000-8000-000000003286";

// Hiperbold (0927, D-129): no fork, emit_event pela sessão pede papel agent ou acima; o
// viewer só lê e é recusado antes de qualquer reserva. Por isso a reserva e o controle usam
// o MESMO agent, e um caso próprio prova a recusa do viewer.
function emitirComo(
  papel: "viewer" | "agent" | "service_role",
  tipo: string,
  kind: string,
  id: string,
): string {
  const sessao =
    papel === "service_role"
      ? `set local role service_role;`
      : `set local role authenticated;
         select set_config('request.jwt.claims', '{"sub":"${papel === "agent" ? GOV_AGENT_A : GOV_VIEWER}"}', true) is not null;`;
  return `
    \\set VERBOSITY verbose
    begin;
    ${sessao}
    select set_config('t3286.id', public.emit_event('${tipo}', '${kind}', '${id}'::uuid,
      '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid)::text, true) is not null;
    select 'CARIMBO:' || (payload ? 'service_origin')::text
      from public.event_log where id = current_setting('t3286.id')::uuid;
    rollback;`;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO}', '${GOV_ORG}', 'Data do funil #3286', '+5511999993286')
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
      values ('${NEGOCIO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${CONTATO}', 'Negócio #3286')
      on conflict do nothing;
  `);
});

describe("0743 — emit_event reserva lead.date_field_due ao servidor", () => {
  it("um agent NÃO emite lead.date_field_due — 42501", () => {
    let erro: string | null = null;
    try {
      sql(emitirComo("agent", "lead.date_field_due", "crm_lead", NEGOCIO));
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "um agent emitiu lead.date_field_due SEM erro").not.toBeNull();
    expect(erro).toContain("42501");
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: o MESMO agent emite um tipo não reservado", () => {
    // Sem isto, um 42501 de outra origem (membership, suporte somente leitura)
    // leria como "a reserva funcionou".
    expect(sql(emitirComo("agent", "contact.tag_added", "contact", GOV_CONTACT_1))).toContain("CARIMBO:");
  });

  it("Hiperbold (D-129): o viewer não emite nem o tipo não reservado", () => {
    let erro: string | null = null;
    try {
      sql(emitirComo("viewer", "contact.tag_added", "contact", GOV_CONTACT_1));
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "um viewer emitiu SEM erro").not.toBeNull();
    expect(erro).toContain("caller_not_authorized_for_org");
  });

  it("o servidor (service_role, como o cron) emite lead.date_field_due e o evento nasce com origem", () => {
    expect(sql(emitirComo("service_role", "lead.date_field_due", "crm_lead", NEGOCIO))).toContain(
      "CARIMBO:true",
    );
  });
});
