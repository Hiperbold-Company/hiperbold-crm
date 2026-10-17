/**
 * D-216: o contexto das automações não leva `cpf_hash` nem `cpf_encrypted`, e nenhum texto os renderiza.
 *
 * O motor lia o contato com `select("*")`: o hash e o cifrado do CPF entravam no contexto e `{{contact.cpf_hash}}`
 * podia sair numa mensagem ao cliente. O banco de mentira abaixo PROJETA as colunas pedidas, como o PostgREST faz, e
 * guarda um contato COM as duas colunas: só quem pede `*` (ou as nomeia) as recebe.
 */
import { describe, expect, it } from "vitest";

import { buildContext } from "@/lib/automation/engine";
import { renderTemplate } from "@/lib/automation/template";
import { COLUNAS_DO_CONTATO_SEM_CPF } from "@/lib/contacts/colunas";

const ORG = "11111111-1111-4111-8111-111111111111";

const CONTATO = {
  id: "contato-1",
  organization_id: ORG,
  name: "Ana Souza",
  phone_number: "+5511999990000",
  cpf_hash: "hash-secreto-do-cpf",
  cpf_encrypted: "\\xcifrado-secreto",
};

const TABELAS: Record<string, Array<Record<string, unknown>>> = {
  contacts: [CONTATO],
  crm_leads: [{ id: "lead-1", organization_id: ORG, contact_id: "contato-1", title: "Pedido" }],
  calendar_appointments: [{ id: "ag-1", organization_id: ORG, contact_id: "contato-1" }],
};

/** Cliente que filtra por `eq` e projeta as colunas do `select`, como o PostgREST. */
function bancoQueProjeta() {
  const pedidos: Array<{ tabela: string; colunas: string }> = [];
  const from = (tabela: string) => {
    let colunas = "*";
    const filtros: Array<[string, unknown]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: (c: string) => {
        colunas = c;
        pedidos.push({ tabela, colunas: c });
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      maybeSingle: async () => {
        const linha = (TABELAS[tabela] ?? []).find((l) => filtros.every(([c, v]) => l[c] === v));
        if (!linha) return { data: null, error: null };
        if (colunas.trim() === "*") return { data: { ...linha }, error: null };
        const pedidas = colunas.split(",").map((c) => c.trim());
        return { data: Object.fromEntries(Object.entries(linha).filter(([k]) => pedidas.includes(k))), error: null };
      },
    };
    return q;
  };
  return { admin: { from } as never, pedidos };
}

const evento = (entity_kind: string, entity_id: string, payload: Record<string, unknown> = {}) =>
  ({
    id: "ev-1",
    organization_id: ORG,
    event_type: "x",
    entity_kind,
    entity_id,
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  }) as never;

describe("contexto das automações", () => {
  it.each([
    ["contato", evento("contact", "contato-1")],
    ["negócio com contato", evento("crm_lead", "lead-1")],
    ["compromisso com contato", evento("calendar_appointment", "ag-1")],
    ["mensagem", evento("message", "msg-1", { contact_id: "contato-1" })],
  ])("o contato lido para %s não traz as colunas do CPF", async (_nome, ev) => {
    const { admin, pedidos } = bancoQueProjeta();
    const ctx = (await buildContext(admin, ev)) as { contact?: Record<string, unknown> };

    expect(ctx.contact?.name).toBe("Ana Souza");
    expect(ctx.contact).not.toHaveProperty("cpf_hash");
    expect(ctx.contact).not.toHaveProperty("cpf_encrypted");
    expect(pedidos.filter((p) => p.tabela === "contacts").every((p) => p.colunas === COLUNAS_DO_CONTATO_SEM_CPF)).toBe(true);
  });

  it("a lista de colunas não nomeia o CPF nem usa `*`", () => {
    expect(COLUNAS_DO_CONTATO_SEM_CPF).not.toMatch(/cpf_|\*/);
  });
});

describe("renderTemplate e o CPF", () => {
  it("{{contact.cpf_hash}} e {{contact.cpf_encrypted}} viram vazio mesmo que o contexto traga a coluna", () => {
    const texto = renderTemplate("A[{{contact.cpf_hash}}] B[{{ contact.cpf_encrypted }}] C[{{contact.name}}]", {
      contact: CONTATO,
    });
    expect(texto).toBe("A[] B[] C[Ana Souza]");
    expect(texto).not.toContain("secreto");
  });
});
