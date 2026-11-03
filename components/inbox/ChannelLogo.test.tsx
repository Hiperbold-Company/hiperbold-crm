import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChannelLogo } from "./ChannelLogo";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const canal = (provider: string, social_platform: string | null = null) => ({
  phone_number: null,
  display_name: null,
  provider,
  social_platform,
});

describe("ChannelLogo", () => {
  it.each([
    ["uazapi", null, "WhatsApp"],
    ["meta_cloud", null, "WhatsApp"],
    ["meta_social", "instagram", "Instagram"],
    ["meta_social", "facebook", "Messenger"],
  ])("%s/%s vira o azulejo de %s", (provider, plataforma, nome) => {
    const { container } = render(<ChannelLogo channel={canal(provider, plataforma)} size={16} />);
    expect(screen.getByRole("img", { name: nome })).toBeTruthy();
    expect(container.querySelector("svg rect[rx='10']")).toBeTruthy();
  });

  it("dois selos de gradiente na mesma tela não dividem o mesmo id", () => {
    const { container } = render(
      <>
        <ChannelLogo channel={canal("meta_social", "instagram")} />
        <ChannelLogo channel={canal("meta_social", "instagram")} />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("canal desconhecido segue com o balão neutro", () => {
    render(<ChannelLogo channel={canal("outro")} />);
    expect(screen.getByRole("img", { name: "Canal" })).toBeTruthy();
  });
});
