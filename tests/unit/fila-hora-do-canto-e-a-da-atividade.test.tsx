import { render, screen } from "@testing-library/react";
import { format, subDays } from "date-fns";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A HORA NO CANTO DA LINHA RESPONDE À MESMA PERGUNTA QUE ORDENA A LISTA.
 *
 * Desde o lote 2026-10-22 todas as abas, a Fila inclusive, saem por atividade
 * recente (`last_message_at` decrescente). A hora do canto acompanha: é a da
 * última mensagem de qualquer lado, em toda linha — senão a coluna de horas sai
 * fora de ordem de cima para baixo, que é como uma lista certa se lê como
 * aleatória (#464). Na Fila, "desde quando o cliente espera" segue dito pela
 * pílula "Aguardando há…" (por `esperaDaConversa`), ao lado da posição.
 *
 * As datas do caso ficam a ≥7 dias, no ramo `dd/MM` do formatador: `format`
 * puro, sem arredondamento e sem idioma, então o caso mede QUAL data alimenta o
 * relógio, não como o texto sai.
 */

const agora = new Date();
/** Espera medida — é ela que numera a posição na Fila (#990). */
const espera = subDays(agora, 9).toISOString();
/** A última mensagem do cliente, MAIS NOVA que a espera. */
const ultimaDoCliente = subDays(agora, 1).toISOString();
/** Última mensagem de qualquer lado — a régua da lista e do canto. */
const atividade = subDays(agora, 12).toISOString();
/** Criação da conversa — o fallback, e o relógio mais antigo dos três. */
const criacao = subDays(agora, 300).toISOString();

const horaDaEspera = format(new Date(espera), "dd/MM");
const horaDaUltimaDoCliente = format(new Date(ultimaDoCliente), "dd/MM");
const horaDaAtividade = format(new Date(atividade), "dd/MM");
const horaDaCriacao = format(new Date(criacao), "dd/MM");

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  last_message_at: atividade,
  last_inbound_at: ultimaDoCliente,
  awaiting_since: espera,
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: criacao,
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

/** `queuePosition` dado = a linha está na Fila (é o mesmo sinal que o badge usa). */
const pintar = (conv: ConversationWithContact, queuePosition?: number) =>
  render(
    <ConversationListItem
      conversation={conv}
      isSelected={false}
      onSelect={() => {}}
      queuePosition={queuePosition}
      mostrarCanal={false}
    />,
  );

const pilulaDaEspera = () => screen.getByTitle("Desde quando o cliente espera resposta");

describe("na Fila, o relógio do canto é o da ordem da lista", () => {
  it("⭐ a hora do canto é a da ATIVIDADE — a mesma régua que ordena a lista", () => {
    pintar(base, 3);
    expect(screen.getByText(horaDaAtividade)).toBeInTheDocument();
  });

  it("⭐ não é a espera, nem a última do cliente, nem a criação", () => {
    pintar(base, 3);
    expect(screen.queryByText(horaDaEspera)).not.toBeInTheDocument();
    expect(screen.queryByText(horaDaUltimaDoCliente)).not.toBeInTheDocument();
    expect(screen.queryByText(horaDaCriacao)).not.toBeInTheDocument();
  });

  it("a espera continua dita — na pílula, com o rótulo do que ela é", () => {
    pintar(base, 3);
    expect(pilulaDaEspera()).toHaveTextContent(/Aguardando/);
    expect(screen.getByText("3º")).toBeInTheDocument();
  });

  it("na Fila sem posição conhecida: a pílula fica, o número não é inventado", () => {
    render(
      <ConversationListItem
        conversation={base}
        isSelected={false}
        onSelect={() => {}}
        naFila
        mostrarCanal={false}
      />,
    );
    expect(pilulaDaEspera()).toBeInTheDocument();
    expect(screen.queryByText(/^\d+º$/)).not.toBeInTheDocument();
  });
});

describe("fora da Fila, nada muda", () => {
  it("CONTROLE: sem posição na fila, a hora segue sendo a da atividade recente", () => {
    pintar(base);
    expect(screen.getByText(horaDaAtividade)).toBeInTheDocument();
    expect(screen.queryByText(horaDaEspera)).not.toBeInTheDocument();
  });

  it("sem pílula de espera fora da Fila", () => {
    pintar(base);
    expect(screen.queryByTitle("Desde quando o cliente espera resposta")).not.toBeInTheDocument();
  });
});
