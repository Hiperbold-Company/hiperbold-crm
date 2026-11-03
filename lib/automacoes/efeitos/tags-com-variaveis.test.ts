/**
 * "Adicionar tag" / "Remover tag" trocam variáveis como os outros blocos:
 * `{{param.origem}}` vira o valor, não a tag literal. Tag que fica vazia é
 * descartada; todas vazias levam ao ramo Erro com motivo legível.
 *
 * Roda pelo executor de produção. O banco é um objeto que recusa qualquer
 * acesso: os casos abaixo não precisam escrever (a tag já existe, ou nenhuma
 * sobrou), e uma escrita indevida — a tag literal `{{param.origem}}` — vira
 * falha visível do teste.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { PedidoDeEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

import type { FatosDaAutomacao } from "../fatos";
import type { CrmAction } from "../schemas";
import { fraseDoErro } from "../vocabulario";
import { criarExecutorDeEfeitos } from "./index";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CONTATO = "20000000-0000-4000-8000-000000000001";

const semBanco = new Proxy(
  {},
  {
    get() {
      throw new Error("acesso ao banco inesperado");
    },
  },
) as SupabaseClient;

function pedido(acao: CrmAction, tags: string[], param: Record<string, unknown>): PedidoDeEfeito {
  const fatos = {
    contato: {
      id: CONTATO,
      name: "Maria",
      email: null,
      phone_number: null,
      birthdate: null,
      tags,
      custom_fields: {},
    },
    negocio: null,
    negocios: [],
    vars: { param },
  } as unknown as FatosDaAutomacao;
  return {
    enrollment: {
      id: "e1",
      organization_id: ORG,
      contact_id: CONTATO,
      pointer_id: "p1",
    } as EnrollmentRow,
    node: {
      id: "acao-1",
      type: "crm_action",
      label: "Tags",
      position: { x: 0, y: 0 },
      config: { actions: [acao], on_error: "route" },
    } as FlowNode,
    fatos,
    chave: "acao-1:1",
  };
}

const executor = criarExecutorDeEfeitos(semBanco, { podeProduzir: async () => true });

describe("tags com variáveis", () => {
  it("add_tags renderiza {{param.origem}} (a tag já existe com outra caixa: nada a escrever)", async () => {
    const r = await executor.executar(
      pedido(
        { type: "add_tags", target: "contact", tags: ["{{param.origem}}", "  {{param.nada}} "] },
        ["Anúncio"],
        {
          origem: "  anúncio ",
        },
      ),
    );
    expect(r.desfecho).toEqual({ ok: true });
    expect(r.detalhes?.[0]).toMatchObject({ tipo: "add_tags", resultado: "sem_mudanca", ok: true });
  });

  it("add_tags com todas as tags vazias depois de preencher vai para o Erro com motivo legível", async () => {
    const r = await executor.executar(
      pedido({ type: "add_tags", target: "contact", tags: ["{{param.origem}}"] }, [], {}),
    );
    expect(r.desfecho).toEqual({ ok: false, erro: "tag_vazia" });
    expect(fraseDoErro("tag_vazia")).toBe("a tag ficou vazia depois de preencher as variáveis");
  });

  it("remove_tags também renderiza e também recusa tudo vazio", async () => {
    const vazia = await executor.executar(
      pedido({ type: "remove_tags", target: "contact", tags: ["{{param.x}}"] }, ["vip"], {}),
    );
    expect(vazia.desfecho).toEqual({ ok: false, erro: "tag_vazia" });

    // "vip" renderizado não está entre as tags atuais "lead-frio": nada muda.
    const ausente = await executor.executar(
      pedido({ type: "remove_tags", target: "contact", tags: ["{{param.x}}"] }, ["lead-frio"], {
        x: "vip",
      }),
    );
    expect(ausente.detalhes?.[0]).toMatchObject({ resultado: "sem_mudanca", ok: true });
  });
});
