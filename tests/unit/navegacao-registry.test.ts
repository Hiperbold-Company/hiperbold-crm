import { describe, expect, it } from "vitest";

import {
  NAV_DESTINATIONS,
  NAV_GROUPS,
  canSee,
  hubSections,
  searchable,
  sidebarGroups,
} from "@/lib/navigation/registry";

/**
 * O registro é a fonte única da navegação. Estes testes cobrem as projeções
 * puras — quem renderiza (sidebar, hub, ⌘K) não decide nada, só desenha o que
 * sai daqui. A completude do registro contra as rotas de verdade é assunto de
 * `navegacao-completude.test.ts`.
 */

const ADMIN = { platform: false, role: "admin" as const };
const MANAGER = { platform: false, role: "manager" as const };
const AGENT = { platform: false, role: "agent" as const };
const VIEWER = { platform: false, role: "viewer" as const };

function dest(href: string) {
  const d = NAV_DESTINATIONS.find((x) => x.href === href);
  if (!d) throw new Error(`destino ausente do registro: ${href}`);
  return d;
}

describe("integridade do registro", () => {
  it("não tem href duplicado", () => {
    const vistos = new Map<string, number>();
    for (const d of NAV_DESTINATIONS) vistos.set(d.href, (vistos.get(d.href) ?? 0) + 1);
    const duplicados = [...vistos.entries()].filter(([, n]) => n > 1).map(([href]) => href);
    expect(duplicados).toEqual([]);
  });

  it("todo destino aponta para um grupo declarado", () => {
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    const orfaos = NAV_DESTINATIONS.filter((d) => !ids.has(d.group)).map((d) => d.href);
    expect(orfaos).toEqual([]);
  });

  it("todo destino tem descrição — é o que o hub e o ⌘K mostram", () => {
    const semTexto = NAV_DESTINATIONS.filter((d) => d.description.trim() === "").map((d) => d.href);
    expect(semTexto).toEqual([]);
  });

  it("todo destino de um grupo com hub declara sua seção", () => {
    const comHub = new Set(NAV_GROUPS.filter((g) => g.hub).map((g) => g.id));
    const semSecao = NAV_DESTINATIONS.filter((d) => comHub.has(d.group) && !d.section).map(
      (d) => d.href,
    );
    expect(semSecao).toEqual([]);
  });
});

describe("canSee", () => {
  it("nega quem está abaixo do minRole", () => {
    expect(canSee(dest("/app/audit"), MANAGER.platform, MANAGER.role)).toBe(true);
    expect(canSee(dest("/app/audit"), AGENT.platform, AGENT.role)).toBe(false);
  });

  it("destino sem minRole é visível até para viewer", () => {
    expect(canSee(dest("/app/inbox"), VIEWER.platform, VIEWER.role)).toBe(true);
  });

  it("platform admin vê tudo, inclusive sem org ativa", () => {
    for (const d of NAV_DESTINATIONS) expect(canSee(d, true, null)).toBe(true);
  });

  it("sem papel e sem ser platform admin não vê nada", () => {
    expect(canSee(dest("/app/inbox"), false, null)).toBe(false);
  });
});

describe("sidebarGroups", () => {
  it("devolve os grupos na ordem declarada em NAV_GROUPS", () => {
    const ordem = sidebarGroups(true, null).map((g) => g.group.id);
    const esperada = NAV_GROUPS.map((g) => g.id).filter((id) => ordem.includes(id));
    expect(ordem).toEqual(esperada);
  });

  it("só inclui destino marcado como sidebar", () => {
    const hrefs = sidebarGroups(true, null).flatMap((g) => g.items.map((i) => i.href));
    // Conhecimento existe no registro, mas é do hub — não do sidebar.
    expect(hrefs).not.toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/ai/agents");
  });

  it("Etapas do funil é CRM, não Configurações — o achado que originou esta mudança", () => {
    // ⚠️ ESTA ASSERÇÃO MUDOU DE SUPERFÍCIE, e a propriedade guardada é a mesma.
    // Ela cobrava presença no SIDEBAR, que era só o jeito de a tela deixar de
    // ser "um card perdido em Configurações". Com o hub do CRM (`/app/crm`),
    // ela mora atrás de "Ver tudo em CRM" — continua sendo CRM, continua fora
    // de Configurações, e o caminho tem um clique a mais porque desenhar as
    // colunas do funil é trabalho de montagem, não de todo dia.
    //
    // O que NÃO pode voltar é o destino trocar de grupo: é isso que a primeira
    // asserção prende, e ela não depende de onde o item é desenhado.
    expect(dest("/app/settings/tenant/pipelines").group).toBe("crm");
    const hub = hubSections("crm", true, null).flatMap((s) => s.items.map((i) => i.href));
    expect(hub).toContain("/app/settings/tenant/pipelines");
  });

  it("o CRM tem hub, e o sidebar dele fica só com o uso diário", () => {
    // A decisão que devolveu a dobra em 900px (e2e `navegacao.spec.ts`): quando
    // Tarefas virou o quinto destino de CRM, o menu passou a rolar por 13px.
    // O conserto foi o hub — o desenho que o grupo IA já usava —, não mais
    // densidade raspada do `Sidebar.tsx`.
    //
    // A lista é EXATA de propósito. `toContain` deixaria um sexto item entrar
    // calado no sidebar e reabrir a mesma corrida por pixel.
    //
    // Comandas NÃO entra: ela chegou pedindo a quarta linha, e o e2e mediu o
    // menu rolando em 1280×900 — a mesma corrida por pixel que o hub existe
    // para encerrar. Ela mora dentro do hub, em "O dia a dia da venda", que é
    // onde o grupo com hub recebe tela nova (ver o comentário no destino, em
    // lib/navigation/catalogo.ts).

    // `/app/prospecting` NÃO está aqui, e a ausência é decisão, não esquecimento:
    // a tela existe e é alcançável pelo hub e pelo ⌘K, mas o menu já está no
    // limite — com ela seriam 20 portas e o e2e reprova por scroll em 900px. A
    // razão e a condição que encerram a exceção estão ao lado do item, em
    // `lib/navigation/catalogo.ts`.
    const crm = sidebarGroups(true, null).find((g) => g.group.id === "crm");
    // Tarefas saiu do menu em 15/10/2026 (sidebar só com o essencial): vive no hub
    // de CRM e em Configurações › Atendimento.
    expect(crm?.items.map((i) => i.href)).toEqual([
      "/app/kanban",
      "/app/contacts",
      // "/app/calls" (telefonia por SIP) NÃO entra aqui, e a ausência é a
      // decisão: o módulo é OPCIONAL e nasce desligado (doc 27), então a porta
      // no sidebar custaria um item a TODA instalação — e o vigésimo item é o
      // que faz o menu rolar em 900px, que é a corrida por pixel que este
      // teste existe para vigiar. A tela vive no hub do grupo e no ⌘K. Volta
      // para cá no dia em que o app souber que o módulo está ligado (hoje isso
      // é profile do compose, não estado que o aplicativo conheça).
    ]);
    // E continua alcançável: o hub é a porta dela. (Comandas saiu do produto visível em 16/10/2026,
    // `hiperbold/FUNCOES.md`; Produtos é a prova de que o hub segue sendo a porta do que não está no menu.)
    expect(hubSections("crm", true, null).flatMap((s) => s.items.map((i) => i.href))).toContain(
      "/app/products",
    );
    expect(NAV_GROUPS.find((g) => g.id === "crm")?.hub?.href).toBe("/app/crm");
  });

  it("omite o grupo inteiro quando o papel não vê nenhum item dele", () => {
    // CANAIS é todo manager+/admin: um agent não deve ver o título órfão.
    const ids = sidebarGroups(AGENT.platform, AGENT.role).map((g) => g.group.id);
    expect(ids).not.toContain("canais");
    expect(ids).toContain("atendimento");
  });

  it("o grupo de IA mostra só Agentes no menu; o resto vive no hub e em Configurações", () => {
    // Desde 15/10/2026 (sidebar só com o essencial) Follow-ups e Roteadores
    // saíram do menu. Continuam no hub de IA e, agora, em Configurações › IA.
    // Provedores e Execuções NÃO entram aqui, e a razão é medida: pô-las na
    // sidebar estourou a dobra em 900px (e2e `navegacao.spec.ts`). Elas seguem
    // o padrão das outras nove telas do grupo — alcançáveis pelo hub "Ver tudo
    // em IA", que é o desenho existente para tela de configuração.
    const ia = sidebarGroups(true, null).find((g) => g.group.id === "ia");
    expect(ia?.items.map((i) => i.href)).toEqual(["/app/ai/agents"]);
  });

  it("o menu inteiro, de admin, é o essencial e nesta ordem (decisão do dono, 15/10/2026)", () => {
    const todos = sidebarGroups(false, "admin").flatMap((g) => g.items.map((i) => i.href));
    expect(todos).toEqual([
      "/app/inicio",
      "/app/inbox",
      "/app/radar",
      "/app/kanban",
      "/app/contacts",
      "/app/ai/agents",
      "/app/metrics",
      "/app/activities",
    ]);
  });
});

describe("hubSections", () => {
  it("o hub de Configurações abre pelas telas de conta e empresa e recebe as que saíram do menu", () => {
    const secoes = hubSections("organizacao", false, "admin");
    const nomes = secoes.map((s) => s.section);
    // Conta e empresa primeiro; as que saíram do menu lateral vêm depois.
    expect(nomes.indexOf("Sua conta")).toBeLessThan(nomes.indexOf("Atendimento"));
    const por = (secao: string) =>
      secoes.find((s) => s.section === secao)?.items.map((i) => i.href) ?? [];
    expect(por("Atendimento")).toEqual([
      "/app/agenda",
      "/app/templates",
      "/app/tasks",
      "/app/settings/tenant/agenda",
      // Comandas e Contas e recebimentos: ocultas em 16/10/2026 (hiperbold/FUNCOES.md).
    ]);
    // Provedores oculto (16/10/2026); Credenciais ficou, como recurso avançado; o Jev tem porta própria.
    expect(por("IA")).toEqual(["/app/ai/followups", "/app/ai/routers", "/app/ai/credentials", "/app/ai/jev"]);
    // Meta Ads oculto (16/10/2026).
    expect(por("Canais")).toEqual(["/app/connections", "/app/webhooks"]);
    // Sem duplicar a mesma tela em duas seções do mesmo hub.
    const todos = secoes.flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(todos).size).toBe(todos.length);
  });

  it("o hub de Configurações respeita o papel: agent não recebe as telas de gestão", () => {
    const todos = hubSections("organizacao", false, "agent").flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(todos).toContain("/app/agenda");
    expect(todos).not.toContain("/app/connections");
    expect(todos).not.toContain("/app/ai/routers");
  });

  it("as telas que saíram do menu continuam no ⌘K e no hub do próprio grupo", () => {
    const busca = searchable(false, "admin").map((d) => d.href);
    // Ocultas em 16/10/2026 (hiperbold/FUNCOES.md): somem do ⌘K também.
    for (const h of [
      "/app/comandas",
      "/app/ai/providers",
      "/app/ads/meta",
      "/app/settings/tenant/financeiro",
    ]) {
      expect(busca).not.toContain(h);
    }
    for (const h of [
      "/app/agenda",
      "/app/templates",
      "/app/tasks",
      "/app/ai/followups",
      "/app/ai/routers",
      "/app/ai/credentials",
      "/app/connections",
      "/app/webhooks",
      "/app/settings/tenant/agenda",
      "/app/settings/plano",
    ]) {
      expect(busca).toContain(h);
    }
    const hubIA = hubSections("ia", false, "admin").flatMap((s) => s.items.map((i) => i.href));
    expect(hubIA).toContain("/app/ai/followups");
  });

  it("o hub do CRM é inventário: as telas visíveis do grupo, nas duas seções", () => {
    // As seções são a régua do sidebar escrita por extenso — o que se abre todo
    // dia contra o que se define uma vez. Lista EXATA: `toContain` deixaria uma
    // tela nova entrar sem que ninguém decidisse de que lado dela ela cai.
    const secoes = hubSections("crm", true, null);
    expect(secoes.map((s) => s.section)).toEqual(["O dia a dia da venda", "Preparar a venda"]);
    // Prospecção, Chamadas e Comandas: ocultas em 16/10/2026 (hiperbold/FUNCOES.md).
    expect(secoes.flatMap((s) => s.items.map((i) => i.href))).toEqual([
      "/app/kanban",
      "/app/campaigns",
      "/app/contacts",
      "/app/tasks",
      "/app/products",
      "/app/settings/tenant/pipelines",
    ]);
  });

  it("agrupa a IA nas três etapas da jornada, na ordem", () => {
    const secoes = hubSections("ia", true, null).map((s) => s.section);
    expect(secoes).toEqual(["Montar o agente", "Ensinar o agente", "Acompanhar o agente"]);
  });

  it("o hub mostra também o que já está no sidebar — é inventário, não sobra", () => {
    const hrefs = hubSections("ia", true, null).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/app/ai/agents");
    expect(hrefs).toContain("/app/ai/knowledge/sources");
  });

  it("não vaza destino acima do papel", () => {
    const hrefs = hubSections("organizacao", VIEWER.platform, VIEWER.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefs).not.toContain("/app/settings/api-tokens");
    expect(hrefs).toContain("/app/settings/profile");
  });

  it("Meu plano (F2, tarefa 7) é admin e gerente, não agent nem viewer", () => {
    // Decisão de desenho 13 da fase F2 dos planos: só admin e gerente veem a
    // tela (a antiga Billing, admin-only, saiu do catálogo).
    const hrefsDoGerente = hubSections("organizacao", MANAGER.platform, MANAGER.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    const hrefsDoAdmin = hubSections("organizacao", ADMIN.platform, ADMIN.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    const hrefsDoAgente = hubSections("organizacao", AGENT.platform, AGENT.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    const hrefsDoViewer = hubSections("organizacao", VIEWER.platform, VIEWER.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefsDoGerente).toContain("/app/settings/plano");
    expect(hrefsDoAdmin).toContain("/app/settings/plano");
    expect(hrefsDoAgente).not.toContain("/app/settings/plano");
    expect(hrefsDoViewer).not.toContain("/app/settings/plano");
  });

  it("some com a seção que ficou vazia pela permissão", () => {
    /**
     * Esta asserção era `expect(secoes).not.toContain("Dados e acesso")`, e o
     * que a fazia passar era um ACIDENTE do catálogo: por um tempo, os dois
     * destinos daquela seção eram `admin`. Quando "Dados externos" entrou nela
     * SEM `minRole` — o banco externo é lido por qualquer autenticado, decisão
     * do dono no #1130 —, a seção passou a existir para o `viewer` e o teste
     * ficou vermelho. Ele não pegou defeito nenhum: reprovou o CATÁLOGO por uma
     * mudança que a projeção tratou certo.
     *
     * A propriedade não é sobre uma seção nomeada; é sobre TODA seção, em todo
     * grupo, para todo papel. Escrita assim, ela não envelhece quando alguém
     * acrescenta, move ou reclassifica um destino.
     */
    for (const grupo of NAV_GROUPS) {
      for (const quem of [VIEWER, AGENT, MANAGER, ADMIN]) {
        for (const s of hubSections(grupo.id, quem.platform, quem.role)) {
          expect(
            s.items.length,
            `${grupo.id} / "${s.section}" veio vazia para ${quem.role}`,
          ).toBeGreaterThan(0);
        }
      }
    }

    /**
     * E a testemunha de que a projeção está mesmo sendo exercitada: precisa
     * existir ALGUMA seção que o admin vê e o viewer não. Sem isto, o laço
     * acima seguiria verde num catálogo onde nada é gateado — verde por
     * ausência de caso, que se lê igual a verde por acerto. A seção sai do
     * catálogo, nunca escrita à mão.
     */
    const secoesDe = (quem: typeof VIEWER | typeof ADMIN) =>
      new Set(
        NAV_GROUPS.flatMap((g) =>
          hubSections(g.id, quem.platform, quem.role).map((s) => `${g.id}/${s.section}`),
        ),
      );
    const doViewer = secoesDe(VIEWER);
    const somemParaOViewer = [...secoesDe(ADMIN)].filter((s) => !doViewer.has(s));
    expect(
      somemParaOViewer.length,
      "nenhuma seção some para o viewer — a projeção por papel deixou de ser exercitada",
    ).toBeGreaterThan(0);
  });
});

describe("searchable", () => {
  it("expõe todo destino visível, do sidebar ou não", () => {
    const hrefs = searchable(ADMIN.platform, ADMIN.role).map((d) => d.href);
    expect(hrefs).toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/inbox");
  });

  it("respeita o papel", () => {
    const hrefs = searchable(AGENT.platform, AGENT.role).map((d) => d.href);
    expect(hrefs).not.toContain("/app/audit");
  });
});
