/**
 * ONDA 5 DO REDESIGN — CONFIGURAÇÕES no v49.
 *
 * Retratos da chave DESLIGADA, escritos ANTES da onda 5 contra o código de
 * sempre. Com a chave desligada, o HTML destes componentes tem de ser o mesmo,
 * byte a byte. Com ela ligada, os controles (rótulo, testid, disabled, href,
 * name) são o mesmo conjunto: a onda só muda a aparência.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderBase, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rotas: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (p: string) => ({ data: h.rotas[p.split("?")[0] ?? ""] ?? [] })),
    post: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({})),
  },
}));
vi.mock("@/app/actions/settings/updateProfile", () => ({ updateProfile: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/actions/settings/updateTenant", () => ({ updateTenant: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/actions/auth/enrollMfa", () => ({ enrollMfa: vi.fn() }));
vi.mock("@/app/actions/auth/confirmMfaEnroll", () => ({ confirmMfaEnroll: vi.fn() }));
vi.mock("@/app/actions/auth/useRecoveryCode", () => ({ useRecoveryCode: vi.fn() }));
vi.mock("@/app/actions/settings/regenerateRecoveryCodes", () => ({ regenerateRecoveryCodes: vi.fn() }));
vi.mock("@/app/actions/settings/signOutEverywhere", () => ({ signOutEverywhere: vi.fn() }));
vi.mock("@/app/actions/settings/esquecerDispositivosConfiaveis", () => ({ esquecerDispositivosConfiaveis: vi.fn() }));
vi.mock("@/app/actions/auth/politicaDeMfa", () => ({ definirExigenciaDeMfa: vi.fn(), desativarMfaDaConta: vi.fn() }));
vi.mock("@/components/voice/PainelDeChamadaDeVoz", () => ({ PainelDeChamadaDeVoz: () => null }));

import { colunaDasConfiguracoes } from "@/components/shell/redesign/navegacao";
import { ProfileForm } from "@/app/app/settings/profile/_form";
import { SecurityClient } from "@/app/app/settings/security/_client";
import { PainelDeTags } from "@/app/app/settings/tags/_painel";
import { TenantForm } from "@/app/app/settings/tenant/_form";
import { TeamMembersClient } from "@/app/app/team/_components/TeamMembersClient";
import { NavHub } from "@/components/shell/NavHub";
import { ProvedorDeConfirmacao } from "@/components/ui/confirmar";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { GRUPO_NO_RODAPE, NAV_DESTINATIONS, searchable } from "@/lib/navigation/registry";
import {
  AREAS_DO_V49,
  GRUPOS_DAS_CONFIGURACOES,
  agruparNaColuna,
  areaDaTela,
  gruposDasConfiguracoes,
} from "@/lib/redesign/areas";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { TenantInput } from "@/lib/schemas/settings";
import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ORGANIZACAO: TenantInput = {
  display_name: "Clínica Bem Estar",
  legal_name: "Clínica Bem Estar Ltda",
  cnpj: null,
  country: "BR",
  timezone: "America/Sao_Paulo",
  locale: "pt-BR",
  currency: "BRL",
  media_retention_days: 365,
  media_retention_enforced: true,
  dpo_email: null,
  privacy_policy_url: null,
};

const MEMBRO = {
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "agent",
  invited_at: null,
  accepted_at: "2026-01-01T12:00:00Z",
  revoked_at: null,
  created_at: "2026-01-01T12:00:00Z",
  email: "ana@example.com",
  full_name: "Ana",
  last_sign_in_at: null,
};

const ETIQUETAS: LinhaDeVocabulario[] = [
  { tag: "cliente-vip", uso_em_contatos: 87, uso_em_leads: 3, uso_em_conversas: 2, em_regras: 1, cor: null, descricao: null, no_vocabulario: true },
  { tag: "lead-quente", uso_em_contatos: 64, uso_em_leads: 0, uso_em_conversas: 0, em_regras: 0, cor: null, descricao: null, no_vocabulario: false },
];

function Envoltorio({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <IdiomaProvider locale="pt-BR">
        <ProvedorDeConfirmacao>{children}</ProvedorDeConfirmacao>
      </IdiomaProvider>
    </QueryClientProvider>
  );
}

function render(ui: ReactNode) {
  return renderBase(<Envoltorio>{ui}</Envoltorio>);
}

interface Tela {
  nome: string;
  /** `ligado` só importa ao índice, que recebe a chave por prop (decidida no servidor). */
  ui: (ligado: boolean) => ReactNode;
  /** Texto que prova que a tela terminou de montar (a Equipe carrega pela API). */
  pronto: string;
}

const TELAS: Tela[] = [
  {
    nome: "Perfil",
    ui: () => (
      <ProfileForm
        email="dona@empresa.com"
        initialFullName="Dona"
        initialAvatarUrl={null}
        initialLocale="pt-BR"
        initialTimezone="America/Sao_Paulo"
      />
    ),
    pronto: "Nome completo",
  },
  { nome: "Organização", ui: () => <TenantForm initial={ORGANIZACAO} />, pronto: "Nome de exibição" },
  {
    nome: "Segurança",
    ui: () => (
      <SecurityClient
        mfaEnrolled={false}
        obrigatorio={false}
        podeExigirDaEquipe
        papelMinimo="none"
        diasDeCarencia={0}
        dispositivos={[]}
      />
    ),
    pronto: "Verificação em duas etapas",
  },
  { nome: "Equipe", ui: () => <TeamMembersClient currentUserId="x" canManage />, pronto: "ana@example.com" },
  { nome: "Tags", ui: () => <PainelDeTags tags={ETIQUETAS} idioma="pt-BR" />, pronto: "cliente-vip" },
  {
    nome: "Índice",
    ui: (ligado) => (
      <NavHub
        group="organizacao"
        isPlatformAdmin={false}
        role="admin"
        modulosLigados={[]}
        title="Configurações"
        subtitle="Sua conta, a empresa e as integrações"
        redesignConfiguracoes={ligado}
      />
    ),
    pronto: "Configurações",
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
  h.rotas = { "/api/v1/team": [MEMBRO] };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.rotas = {};
});

describe("onda 5 — Configurações, retrato da chave DESLIGADA", () => {
  for (const tela of TELAS) {
    it(`${tela.nome}`, async () => {
      const { container } = render(<ProvedorDoRedesign ligado={false}>{tela.ui(false)}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      // O id que o React gera (`radix-_r_8d_`) depende da ordem de montagem dos casos; fora dele, byte a byte.
      expect(container.innerHTML.replace(/_r_[a-z0-9]+_/g, "_r_")).toMatchSnapshot();
    });
  }
});

/* ── Chave LIGADA: nenhum controle muda ─────────────────────────────────── */

/** Botões, links e campos na ordem do DOM: rótulo, testid, disabled, href e name. */
function controles(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role='tab'], [role='switch'], [role='combobox']"),
  ).map((el) =>
    [
      el.tagName,
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("data-testid") ?? "",
      el.hasAttribute("disabled") ? "disabled" : "",
      el.getAttribute("href") ?? "",
      el.getAttribute("name") ?? "",
      // O id que o React gera (`radix-_r_8d_`) muda a cada montagem; o resto do id fica.
      (el.getAttribute("id") ?? "").replace(/_r_[a-z0-9]+_/g, "_r_"),
    ].join(" | "),
  );
}

describe("onda 5 — Configurações com a chave LIGADA", () => {
  for (const tela of TELAS) {
    it(`${tela.nome}: mesmos botões, links e campos ligado e desligado`, async () => {
      const off = render(<ProvedorDoRedesign ligado={false}>{tela.ui(false)}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      const desligado = controles(off.container);
      cleanup();
      const on = render(<ProvedorDoRedesign ligado>{tela.ui(true)}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      expect(desligado.length).toBeGreaterThan(0);
      expect(controles(on.container)).toEqual(desligado);
    });
  }

  it("a barra de salvar continua uma só, com o mesmo botão, no Perfil e na Organização", async () => {
    for (const tela of TELAS.filter((x) => x.nome === "Perfil" || x.nome === "Organização")) {
      const { container } = render(<ProvedorDoRedesign ligado>{tela.ui(true)}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      const barras = container.querySelectorAll('[data-rd-configuracoes="barra-de-salvar"]');
      expect(barras).toHaveLength(1);
      expect(barras[0]?.querySelectorAll('button[type="submit"]')).toHaveLength(1);
      cleanup();
    }
  });
});

/* ── O menu vertical de Configurações (puro) ─────────────────────────────── */

const TODOS = NAV_DESTINATIONS;
const DA_CONFIGURACAO = TODOS.filter((d) => d.group === GRUPO_NO_RODAPE);

describe("gruposDasConfiguracoes — Você / Empresa / Integrações", () => {
  it("com tudo visível, os três grupos na ordem do v49", () => {
    const grupos = gruposDasConfiguracoes(DA_CONFIGURACAO);
    expect(grupos.map((g) => g.rotulo)).toEqual(["Você", "Empresa", "Integrações"]);
    expect(grupos[0]?.itens.map((i) => i.href)).toEqual([
      "/app/settings/profile",
      "/app/settings/security",
      "/app/settings/notifications",
      "/app/settings/aplicativo",
      "/app/ajuda",
    ]);
    expect(grupos[1]?.itens.slice(0, 3).map((i) => i.href)).toEqual([
      "/app/settings/tenant",
      "/app/team",
      "/app/settings/atendimento",
    ]);
    expect(grupos[2]?.itens[0]?.href).toBe("/app/settings/conversoes");
  });

  it("nenhuma porta se perde nem se repete: todo destino do grupo que não é de área aparece uma vez", () => {
    const deArea = new Set(AREAS_DO_V49.flatMap((a) => a.abas));
    const esperado = DA_CONFIGURACAO.map((d) => d.href).filter((h) => !deArea.has(h)).sort();
    const hrefs = gruposDasConfiguracoes(DA_CONFIGURACAO).flatMap((g) => g.itens.map((i) => i.href));
    expect([...hrefs].sort()).toEqual(esperado);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("destino que é aba de uma área (Tipos e Aviso de agendamento) fica na área, não na coluna", () => {
    const hrefs = gruposDasConfiguracoes(DA_CONFIGURACAO).flatMap((g) => g.itens.map((i) => i.href));
    expect(hrefs).not.toContain("/app/settings/tenant/agenda");
    expect(hrefs).not.toContain("/app/agenda/avisos");
  });

  it("destino sem grupo conhecido cai no fim do último grupo, na ordem em que chegou", () => {
    const novos = [{ href: "/app/settings/z-nova" }, { href: "/app/settings/a-outra" }];
    const grupos = gruposDasConfiguracoes([{ href: "/app/settings/profile" }, ...novos]);
    expect(grupos.map((g) => g.rotulo)).toEqual(["Você", "Integrações"]);
    expect(grupos[1]?.itens.map((i) => i.href)).toEqual(["/app/settings/z-nova", "/app/settings/a-outra"]);
  });

  it("destino fora da entrada nunca aparece: só organiza o que o papel já vê", () => {
    const grupos = gruposDasConfiguracoes([{ href: "/app/team" }]);
    expect(grupos).toEqual([{ rotulo: "Empresa", itens: [{ href: "/app/team" }] }]);
    expect(gruposDasConfiguracoes([])).toEqual([]);
  });

  it("a ordem não depende da ordem de entrada", () => {
    const a = gruposDasConfiguracoes(DA_CONFIGURACAO).flatMap((g) => g.itens.map((i) => i.href));
    const b = gruposDasConfiguracoes([...DA_CONFIGURACAO].reverse()).flatMap((g) => g.itens.map((i) => i.href));
    expect(b).toEqual(a);
  });

  it("agruparNaColuna sem restoNoUltimo descarta o que nenhum grupo declara (é a regra da IA)", () => {
    expect(agruparNaColuna([{ rotulo: "A", abas: ["/x"] }], [{ href: "/y" }])).toEqual([]);
  });

  it("cerca: todo href dos grupos existe no catálogo e no grupo de Configurações", () => {
    const doGrupo = new Set(DA_CONFIGURACAO.map((d) => d.href));
    for (const h of GRUPOS_DAS_CONFIGURACOES.flatMap((g) => g.abas)) expect(doGrupo.has(h), h).toBe(true);
  });

  it("o papel decide: um atendente não vê Organização, LGPD nem Chaves de integração na coluna", () => {
    const visiveis = searchable(false, "agent", undefined, [], []);
    const hrefs = gruposDasConfiguracoes(visiveis.filter((d) => d.group === GRUPO_NO_RODAPE)).flatMap((g) =>
      g.itens.map((i) => i.href),
    );
    expect(hrefs).toContain("/app/settings/profile");
    for (const h of ["/app/settings/tenant", "/app/lgpd/requests", "/app/settings/api-tokens"]) {
      expect(hrefs).not.toContain(h);
    }
  });
});

describe("colunaDasConfiguracoes — quando a coluna aparece e a trilha", () => {
  const visiveis = searchable(false, "admin", undefined, [], []);
  function coluna(pathname: string) {
    const area = areaDaTela(pathname, visiveis);
    const atual = visiveis
      .filter((d) => pathname === d.href || pathname.startsWith(`${d.href}/`))
      .sort((x, y) => y.href.length - x.href.length)[0];
    return colunaDasConfiguracoes(pathname, visiveis, area, atual);
  }

  it("no índice /app/settings: coluna sem grupo aceso", () => {
    const c = coluna("/app/settings");
    expect(c.grupos.length).toBeGreaterThan(0);
    expect(c.grupoDaTela).toBeUndefined();
  });

  it("em /app/team: grupo Empresa", () => {
    expect(coluna("/app/team").grupoDaTela).toBe("Empresa");
  });

  it("em /app/settings/profile: grupo Você; em /app/settings/api-tokens: Integrações", () => {
    expect(coluna("/app/settings/profile").grupoDaTela).toBe("Você");
    expect(coluna("/app/settings/api-tokens").grupoDaTela).toBe("Integrações");
  });

  it("tela de Configurações que o catálogo não lista (billing) também tem a coluna", () => {
    expect(coluna("/app/settings/billing").grupos.length).toBeGreaterThan(0);
  });

  it("tela de uma área do v49 não tem a coluna (Etapas do funil, Tipos de agendamento)", () => {
    expect(coluna("/app/settings/tenant/pipelines").grupos).toEqual([]);
    expect(coluna("/app/settings/tenant/agenda").grupos).toEqual([]);
  });

  it("fora de Configurações não há coluna", () => {
    expect(coluna("/app/contacts").grupos).toEqual([]);
  });
});
