import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChannelLogo } from "./ChannelLogo";
import {
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_META_SOCIAL,
} from "@/lib/channels/capabilities";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const canal = (provider: string, social_platform: string | null = null) => ({
  phone_number: null,
  display_name: null,
  provider,
  social_platform,
});

describe("ChannelLogo", () => {
  it.each([
    [CHANNEL_PROVIDER_META, null, "WhatsApp"],
    [CHANNEL_PROVIDER_META_SOCIAL, "instagram", "Instagram"],
    [CHANNEL_PROVIDER_META_SOCIAL, "facebook", "Messenger"],
  ])("%s/%s vira o azulejo de %s", (provider, plataforma, nome) => {
    const { container } = render(<ChannelLogo channel={canal(provider, plataforma)} size={16} />);
    expect(screen.getByRole("img", { name: nome })).toBeTruthy();
    expect(container.querySelector("svg rect[rx='10']")).toBeTruthy();
  });

  it("dois selos de gradiente na mesma tela não dividem o mesmo id", () => {
    const { container } = render(
      <>
        <ChannelLogo channel={canal(CHANNEL_PROVIDER_META_SOCIAL, "instagram")} />
        <ChannelLogo channel={canal(CHANNEL_PROVIDER_META_SOCIAL, "instagram")} />
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
