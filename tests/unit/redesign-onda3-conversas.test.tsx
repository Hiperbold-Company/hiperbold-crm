/**
 * ONDA 3 DO REDESIGN — Conversas: o cabeçalho da conversa no v49.
 *
 * Desligada: o cabeçalho é o de sempre, provado pelo retrato inteiro em
 * quatro estados (aberta pela IA, minha, encerrada, arquivada de grupo).
 *
 * Ligada: as ações do dia a dia (Buscar, Assumir/Liberar, Devolver/Pausar,
 * Transferir, Fechar/Reabrir, Ver contato, e Lembrar e Convidar, que mostram
 * estado) ficam à vista; as raras (Ligar, Reservar serviço, Vídeo, Ensinar,
 * Arquivar, pessoal) vão
 * para um "Mais ações" que só ESCONDE — tudo continua montado. O CONJUNTO de
 * ações alcançáveis é o mesmo por papel e por estado; sem ação rara, nada de
 * gatilho vazio.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

const h = vi.hoisted(() => ({ role: "manager" as string }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: h.role },
  }),
  useActiveOrg: () => ({ orgId: "org-1", role: h.role }),
}));
// As ações raras viram botões rotulados: o que se mede é ONDE ficam e se
// continuam alcançáveis, não o comportamento de cada uma.
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => <button type="button">Ligar</button> }));
vi.mock("@/components/agenda/ReservarServicoNaConversa", () => ({
  ReservarServicoNaConversa: () => <button type="button">Reservar serviço</button>,
}));
vi.mock("@/components/inbox/VideoCallButton", () => ({
  VideoCallButton: () => <button type="button">Vídeo</button>,
}));
vi.mock("@/components/inbox/ParticipantesDaConversa", () => ({
  ParticipantesDaConversa: (p: { podeConvidar: boolean }) =>
    p.podeConvidar ? <button type="button">Convidar</button> : null,
}));
vi.mock("@/components/inbox/SnoozeButton", () => ({ SnoozeButton: () => <button type="button">Lembrar</button> }));
vi.mock("@/components/inbox/EnsinarAgenteButton", () => ({
  EnsinarAgenteButton: () => <button type="button">Ensinar o agente</button>,
}));

type Conv = ComponentProps<typeof ConversationHeader>["conversation"];
const BASE = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  status: "open",
  assigned_to_user_id: null,
  assignee_kind: "ai",
  snooze_until: null,
  is_group: false,
  tags: [],
  contacts: { id: "ct-1", display_name: "Fulana", name: null, phone_number: "5511999990000", is_personal: false },
};
const ESTADOS: Record<string, Conv> = {
  "aberta pela IA": BASE as unknown as Conv,
  minha: { ...BASE, assigned_to_user_id: "u-1", assignee_kind: "human" } as unknown as Conv,
  encerrada: { ...BASE, status: "closed", assigned_to_user_id: "u-1", assignee_kind: "human" } as unknown as Conv,
  "arquivada de grupo": { ...BASE, status: "archived", is_group: true } as unknown as Conv,
  "contato pessoal": { ...BASE, contacts: { ...BASE.contacts, is_personal: true } } as unknown as Conv,
};

function montar(conv: Conv, ligado: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDoRedesign ligado={ligado}>
        <ConversationHeader conversation={conv} onBuscar={() => {}} />
      </ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

const RARAS = [
  "Reservar serviço",
  "Vídeo",
  "Arquivar",
  "Marcar como pessoal",
  "Desmarcar pessoal",
];

/** Rótulos dos botões e links, sem o próprio "Mais ações". */
function rotulos(el: Element): string[] {
  return [...el.querySelectorAll("button, a, summary")]
    .map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
    .filter((r) => r && r !== "Mais ações");
}

beforeEach(() => {
  h.role = "manager";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("onda 3 — Conversas, chave DESLIGADA", () => {
  it.each(Object.keys(ESTADOS))("cabeçalho (%s): HTML idêntico ao de sempre", (estado) => {
    const { container } = montar(ESTADOS[estado]!, false);
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe("onda 3 — Conversas, chave LIGADA", () => {
  const casos = Object.keys(ESTADOS).flatMap((e) => ["manager", "agent", "viewer"].map((r) => [e, r] as const));
  it.each(casos)("%s (%s): o mesmo conjunto de ações; as raras no 'Mais ações'", (estado, role) => {
    h.role = role;
    const antes = rotulos(montar(ESTADOS[estado]!, false).container).sort();
    cleanup();

    const { container } = montar(ESTADOS[estado]!, true);
    expect(rotulos(container).sort()).toEqual(antes);

    const mais = container.querySelector('[data-rd-chat="mais-acoes"]');
    const rarasDoCaso = antes.filter((r) => RARAS.includes(r));
    // O <details> sempre monta; quem esconde o gatilho vazio é o CSS (:has,
    // provado no navegador). Aqui: a lista só tem filhos quando há ação rara.
    const lista = mais?.querySelector('[data-rd-chat="mais-acoes-lista"]');
    expect((lista?.children.length ?? 0) > 0).toBe(rarasDoCaso.length > 0);
    if (mais) {
      expect(rotulos(mais).sort()).toEqual(rarasDoCaso.sort());
    }
    // As do dia a dia nunca vão para o menu.
    for (const r of ["Assumir", "Liberar", "Transferir", "Fechar", "Reabrir", "Buscar nesta conversa", "Lembrar", "Convidar", "Ligar", "Ensinar o agente"]) {
      if (antes.includes(r)) expect(mais ? rotulos(mais) : []).not.toContain(r);
    }
  });
});
