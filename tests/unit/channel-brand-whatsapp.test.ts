import { describe, expect, it } from "vitest";

import { CHANNEL_PROVIDER_UAZAPI } from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";

describe("channelBrand", () => {
  // A UAZAPI caía em "unknown" e o Chat mostrava o balão cinza em vez do WhatsApp.
  it("número conectado pela API não oficial é WhatsApp", () => {
    expect(channelBrand({ provider: CHANNEL_PROVIDER_UAZAPI })).toBe("whatsapp");
  });
});
