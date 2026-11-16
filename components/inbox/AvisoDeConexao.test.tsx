import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O aviso do Chat: "Você está respondendo pela conexão <nome>" quando a conversa
 * aberta NÃO está numa conexão vinculada a quem vê; e, no modo "só a conexão
 * própria", o motivo que trava a resposta (16/11/2026).
 */
const minhas = vi.hoisted(() => ({ valor: undefined as unknown }));
vi.mock("@/hooks/inbox/useMinhasConexoes", () => ({ useMinhasConexoes: () => minhas.valor }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({
    data: [
      { id: "sess-rosana", display_name: "Rosana Comercial", phone_number: "551100", status: "WORKING" },
      { id: "sess-ingrid", display_name: "Ingrid Müller", phone_number: "551101", status: "WORKING" },
      { id: "sess-geral", display_name: "Número geral", phone_number: "551102", status: "WORKING" },
    ],
  }),
}));

import { AvisoDeConexao } from "./AvisoDeConexao";

const ROSANA = "user-rosana";

const deRosana = (restrito = false) => ({
  modo: restrito ? "own_only" : "choose",
  restrito,
  minha_conexao: { id: "sess-rosana", nome: "Rosana Comercial", conectada: true },
  minhas_conexoes_ids: ["sess-rosana"],
  conexao_geral: { id: "sess-geral", nome: "Número geral", conectada: true },
  conexoes_com_responsavel_ids: ["sess-rosana", "sess-ingrid"],
  conversas: [],
  contato_em_conexao_de_outro: false,
  transferido_para_mim: false,
});

const conversa = (sid: string, extra: Record<string, unknown> = {}) => ({
  channel_session_id: sid,
  status: "open",
  assigned_to_user_id: "user-ingrid",
  ...extra,
});

beforeEach(() => {
  minhas.valor = undefined;
});

describe("AvisoDeConexao", () => {
  it("conversa na conexão da colega → avisa com o NOME da conexão", () => {
    minhas.valor = deRosana();
    render(<AvisoDeConexao conversa={conversa("sess-ingrid")} userId={ROSANA} />);
    const aviso = screen.getByTestId("aviso-de-conexao");
    expect(aviso.textContent).toContain("Você está respondendo pela conexão");
    expect(aviso.textContent).toContain("Ingrid Müller");
  });

  it("conversa na minha conexão → nada", () => {
    minhas.valor = deRosana();
    render(<AvisoDeConexao conversa={conversa("sess-rosana")} userId={ROSANA} />);
    expect(screen.queryByTestId("aviso-de-conexao")).toBeNull();
  });

  it("quem não tem conexão vinculada (ou leitura que falhou) → nada", () => {
    render(<AvisoDeConexao conversa={conversa("sess-ingrid")} userId={ROSANA} />);
    expect(screen.queryByTestId("aviso-de-conexao")).toBeNull();
    minhas.valor = { ...deRosana(), minha_conexao: null, minhas_conexoes_ids: [] };
    render(<AvisoDeConexao conversa={conversa("sess-ingrid")} userId={ROSANA} />);
    expect(screen.queryByTestId("aviso-de-conexao")).toBeNull();
  });

  describe("modo 'só a conexão própria'", () => {
    it("conversa na conexão da colega → mostra o motivo do bloqueio", () => {
      minhas.valor = deRosana(true);
      render(<AvisoDeConexao conversa={conversa("sess-ingrid")} userId={ROSANA} />);
      expect(screen.getByTestId("aviso-de-conexao-bloqueio").textContent).toContain("só responde pela sua conexão");
    });

    it("com número próprio conectado, a transferência não libera (a guarda do número decide)", () => {
      minhas.valor = deRosana(true);
      render(<AvisoDeConexao conversa={conversa("sess-ingrid", { assigned_to_user_id: ROSANA })} userId={ROSANA} />);
      expect(screen.getByTestId("aviso-de-conexao-bloqueio")).toBeInTheDocument();
    });

    it("sem número próprio conectado, conversa ABERTA atribuída a mim (transferida) → não bloqueia", () => {
      minhas.valor = {
        ...deRosana(true),
        minha_conexao: { id: "sess-rosana", nome: "Rosana Comercial", conectada: false },
      };
      render(<AvisoDeConexao conversa={conversa("sess-ingrid", { assigned_to_user_id: ROSANA })} userId={ROSANA} />);
      expect(screen.queryByTestId("aviso-de-conexao-bloqueio")).toBeNull();
      expect(screen.getByTestId("aviso-de-conexao")).toBeInTheDocument();
    });

    it("número geral → não bloqueia", () => {
      minhas.valor = deRosana(true);
      render(<AvisoDeConexao conversa={conversa("sess-geral")} userId={ROSANA} />);
      expect(screen.queryByTestId("aviso-de-conexao-bloqueio")).toBeNull();
    });
  });
});
