import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({ data: { current_version: "1.2.0", latest_version: "v1.3.0", is_owner: true, update_available: true } }));
vi.mock("@/hooks/system/useSystemVersion", () => ({ useSystemVersion: () => state }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
import { VersionFooter } from "./VersionFooter";

afterEach(() => { cleanup(); state.data.update_available = true; });
describe("installed version remains visible beside the update notice", () => {
  it("shows the reported installed version and the newer release separately", () => {
    render(<VersionFooter collapsed={false} />);
    expect(screen.getByText(/1\.2\.0/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /1\.3\.0/ })).toBeTruthy();
  });

  it("still shows the installed version when no update is offered", () => {
    state.data.update_available = false;
    render(<VersionFooter collapsed={false} />);
    expect(screen.getByText(/1\.2\.0/)).toBeTruthy();
  });
});

describe("instalação sem agente do host (EasyPanel)", () => {
  it("mostra a versão da imagem e não acusa 'Execução não confirmada'", () => {
    const antes = { ...state.data };
    Object.assign(state.data, {
      current_version: "1217c9e",
      update_available: false,
      sem_agente: true,
      identity: { status: "unknown" },
    });
    render(<VersionFooter collapsed={false} />);
    expect(screen.getByText(/Versão 1217c9e/)).toBeTruthy();
    expect(screen.queryByText("Execução não confirmada")).toBeNull();
    state.data = antes;
  });

  it("CONTROLE — com agente e execução não confirmada, o aviso continua", () => {
    const antes = { ...state.data };
    Object.assign(state.data, { update_available: false, sem_agente: false, identity: { status: "stale" } });
    render(<VersionFooter collapsed={false} />);
    expect(screen.getByText("Execução não confirmada")).toBeTruthy();
    state.data = antes;
  });
});
