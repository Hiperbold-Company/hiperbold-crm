/**
 * `usePermission` no cliente segue as PERMISSÕES POR PERFIL da organização
 * ativa — o `AuthProvider` de verdade, com as permissões que o layout entrega.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider, usePermission } from "@/hooks/auth/AuthProvider";
import type { ActiveOrg, AuthUser, Role } from "@/lib/auth/types";
import { resolverPermissoes } from "@/lib/permissoes/resolver";

vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: async () => undefined } }),
  resetRealtimeAuthentication: () => undefined,
}));

const user: AuthUser = {
  id: "u1",
  email: "a@exemplo.com",
  full_name: null,
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR",
  organizations: [],
};

function Uma({ acao }: { acao: string }) {
  return <li data-testid={acao}>{String(usePermission(acao))}</li>;
}

function Sonda({ acoes }: { acoes: string[] }) {
  return (
    <ul>
      {acoes.map((a) => (
        <Uma key={a} acao={a} />
      ))}
    </ul>
  );
}

function montar(role: Role, permissoes?: Record<string, string[]>) {
  const activeOrg: ActiveOrg = {
    orgId: "o1",
    name: "Org",
    role,
    ...(permissoes ? { permissoes: resolverPermissoes(permissoes) } : {}),
  };
  render(
    <AuthProvider user={user} activeOrg={activeOrg}>
      <Sonda
        acoes={[
          "contact.export",
          "contatos.exportar",
          "pipeline.create",
          "inbox.reply",
          "contact.create",
        ]}
      />
    </AuthProvider>,
  );
  const valor = (a: string) => screen.getByTestId(a).textContent;
  return valor;
}

describe("usePermission × permissões por perfil", () => {
  it("padrão: atendente não exporta (o piso de antes), mas cria contato", () => {
    const v = montar("agent");
    expect(v("contact.export")).toBe("false");
    expect(v("contatos.exportar")).toBe("false");
    expect(v("contact.create")).toBe("true");
  });

  it("org que liberou a exportação ao atendente: contact.export → contatos.exportar vira true", () => {
    const v = montar("agent", { "contatos.exportar": ["manager", "agent"] });
    expect(v("contact.export")).toBe("true");
    expect(v("contatos.exportar")).toBe("true");
  });

  it("org que tirou 'editar funis' do gerente: pipeline.create vira false; ação fora do catálogo segue o papel", () => {
    const v = montar("manager", { "funis.editar": [] });
    expect(v("pipeline.create")).toBe("false");
    // `inbox.reply` não é mapeado (a Agenda o usa): segue o piso de papel.
    expect(v("inbox.reply")).toBe("true");
  });
});
