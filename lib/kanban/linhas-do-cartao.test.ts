import { describe, expect, it } from "vitest";

import {
  CAMPOS_DO_CARTAO,
  LINHAS_PADRAO,
  linhasDoCartao,
  patchDasLinhasSchema,
  settingsComLinhas,
  valorDaLinha,
} from "./linhas-do-cartao";

describe("linhasDoCartao — o que o funil escolheu, ou o padrão", () => {
  it("⭐ funil nunca configurado (chave ausente) = o card de sempre: última mensagem e telefone", () => {
    expect(linhasDoCartao({})).toEqual(["ultima_mensagem", "telefone"]);
    expect(linhasDoCartao(null)).toEqual(["ultima_mensagem", "telefone"]);
    expect(linhasDoCartao(undefined)).toEqual([...LINHAS_PADRAO]);
  });

  it("devolve a escolha na ordem gravada", () => {
    expect(linhasDoCartao({ card_lines: ["utm_campaign", "email", "cargo"] })).toEqual([
      "utm_campaign",
      "email",
      "cargo",
    ]);
  });

  it("⭐ lista VAZIA é escolha válida, diferente de ausente", () => {
    expect(linhasDoCartao({ card_lines: [] })).toEqual([]);
  });

  it("valor inválido cai no padrão: não é array, mais de 5, campo fora do vocabulário, duplicado", () => {
    expect(linhasDoCartao({ card_lines: "email" })).toEqual([...LINHAS_PADRAO]);
    expect(linhasDoCartao({ card_lines: ["email", "cargo", "empresa", "origem", "telefone", "utm_source"] })).toEqual([
      ...LINHAS_PADRAO,
    ]);
    expect(linhasDoCartao({ card_lines: ["email", "cpf"] })).toEqual([...LINHAS_PADRAO]);
    expect(linhasDoCartao({ card_lines: ["email", "email"] })).toEqual([...LINHAS_PADRAO]);
  });

  it("a cópia devolvida não muta o padrão", () => {
    const linhas = linhasDoCartao({});
    linhas.push("email");
    expect(linhasDoCartao({})).toEqual(["ultima_mensagem", "telefone"]);
  });

  it("o vocabulário tem os 10 campos e só eles", () => {
    expect([...CAMPOS_DO_CARTAO].sort()).toEqual(
      ["cargo", "email", "empresa", "etiquetas", "origem", "telefone", "ultima_mensagem", "utm_campaign", "utm_medium", "utm_source"],
    );
  });
});

describe("patchDasLinhasSchema — o corpo da rota", () => {
  it("aceita até 5 sem repetir, e null (voltar ao padrão)", () => {
    expect(patchDasLinhasSchema.safeParse({ card_lines: ["email", "cargo", "empresa", "origem", "telefone"] }).success).toBe(true);
    expect(patchDasLinhasSchema.safeParse({ card_lines: [] }).success).toBe(true);
    expect(patchDasLinhasSchema.safeParse({ card_lines: null }).success).toBe(true);
  });

  it("recusa duplicado, mais de 5, campo fora do vocabulário, chave extra e corpo sem a chave", () => {
    expect(patchDasLinhasSchema.safeParse({ card_lines: ["email", "email"] }).success).toBe(false);
    expect(
      patchDasLinhasSchema.safeParse({ card_lines: ["email", "cargo", "empresa", "origem", "telefone", "utm_source"] })
        .success,
    ).toBe(false);
    expect(patchDasLinhasSchema.safeParse({ card_lines: ["campo_personalizado"] }).success).toBe(false);
    expect(patchDasLinhasSchema.safeParse({ card_lines: [], fields: [] }).success).toBe(false);
    expect(patchDasLinhasSchema.safeParse({}).success).toBe(false);
  });
});

describe("settingsComLinhas — merge sem apagar as outras chaves", () => {
  it("grava a chave e preserva o resto", () => {
    const atual = { fields: [{ key: "x" }], atalhos: [1], card_lines: ["email"] };
    expect(settingsComLinhas(atual, ["cargo"])).toEqual({ fields: [{ key: "x" }], atalhos: [1], card_lines: ["cargo"] });
    expect(atual.card_lines).toEqual(["email"]);
  });

  it("null APAGA a chave (voltar ao padrão) e preserva o resto", () => {
    const proximo = settingsComLinhas({ fields: [], card_lines: ["email"] }, null);
    expect(proximo).toEqual({ fields: [] });
    expect("card_lines" in proximo).toBe(false);
  });
});

describe("valorDaLinha — de onde vem cada campo", () => {
  const lead = {
    contact_phone: "+5511999998888",
    contact_email: "ana@exemplo.com",
    contact_cargo: "Diretora",
    conversa: { id: "c", preview: "Oi", last_message_at: null, unread: 0 },
    source: "site",
    custom_fields: { utm_source: "google", utm_medium: " cpc ", utm_campaign: "", empresa: "Loja do negócio" },
  };

  it("cada campo lê a sua fonte", () => {
    expect(valorDaLinha(lead, "telefone")).toBe("+5511999998888");
    expect(valorDaLinha(lead, "email")).toBe("ana@exemplo.com");
    expect(valorDaLinha(lead, "ultima_mensagem")).toBe("Oi");
    expect(valorDaLinha(lead, "origem")).toBe("site");
    expect(valorDaLinha(lead, "utm_source")).toBe("google");
    expect(valorDaLinha(lead, "utm_medium")).toBe("cpc");
  });

  it("cargo/empresa: do contato primeiro, senão do custom_fields do negócio", () => {
    expect(valorDaLinha(lead, "cargo")).toBe("Diretora");
    expect(valorDaLinha(lead, "empresa")).toBe("Loja do negócio");
    expect(valorDaLinha({ ...lead, contact_empresa: "Do contato" }, "empresa")).toBe("Do contato");
  });

  it("vazio, só espaço ou ausente é null — a linha some", () => {
    expect(valorDaLinha(lead, "utm_campaign")).toBeNull();
    expect(valorDaLinha({}, "telefone")).toBeNull();
    expect(valorDaLinha({ conversa: null }, "ultima_mensagem")).toBeNull();
    expect(valorDaLinha({ conversa: { id: "c", preview: "  ", last_message_at: null, unread: 0 } }, "ultima_mensagem")).toBeNull();
  });
});

describe("etiquetas — a união das três caixas", () => {
  it("⭐ une negócio, contato e conversas, nessa ordem, sem repetir (maiúsculas não diferenciam; vale a primeira grafia)", () => {
    expect(
      valorDaLinha(
        { tags: ["VIP", "novo"], contact_tags: ["vip", "Indicação"], conversation_tags: ["NOVO", "urgente"] },
        "etiquetas",
      ),
    ).toBe("VIP · novo · Indicação · urgente");
  });

  it("aceita só uma caixa e ignora vazios", () => {
    expect(valorDaLinha({ conversation_tags: ["a"] }, "etiquetas")).toBe("a");
    expect(valorDaLinha({ tags: ["  ", "b"] }, "etiquetas")).toBe("b");
  });

  it("⭐ vazio → null (a linha some)", () => {
    expect(valorDaLinha({}, "etiquetas")).toBeNull();
    expect(valorDaLinha({ tags: [], contact_tags: [], conversation_tags: [] }, "etiquetas")).toBeNull();
  });

  it("o schema do PATCH aceita 'etiquetas'", () => {
    expect(patchDasLinhasSchema.safeParse({ card_lines: ["etiquetas", "email"] }).success).toBe(true);
  });
});
