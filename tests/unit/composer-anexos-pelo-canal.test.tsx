/**
 * O composer não oferece o anexo que o canal não envia: no Instagram e no
 * Messenger oficial (`meta_social`) só texto e imagem saem; voz, vídeo, áudio,
 * documento e cartão de contato voltariam como falha depois do clique.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { anexosOferecidos } from "@/lib/channels/capabilities";

afterEach(() => cleanup());

describe("anexos oferecidos pelo canal", () => {
  it("meta_social: só imagem, sem voz", () => {
    expect(anexosOferecidos("meta_social")).toEqual({
      imagem: true,
      video: false,
      audio: false,
      documento: false,
      contato: false,
      voz: false,
    });
  });
  it("WhatsApp e provider desconhecido: tudo, como antes", () => {
    for (const p of ["waha", "meta_cloud", "uazapi", null, "telegram"]) {
      expect(anexosOferecidos(p)).toMatchObject({ imagem: true, video: true, documento: true, contato: true, voz: true });
    }
  });
  it("o menu do meta_social mostra só Fotos e aceita só imagem", () => {
    const { container } = render(
      <AttachMenu onPick={() => undefined} aceita={{ imagem: true, video: false, documento: false }} />,
    );
    fireEvent.click(screen.getByLabelText("Anexar"));
    expect(screen.getByText("Fotos")).toBeInTheDocument();
    expect(screen.queryByText("Documento")).not.toBeInTheDocument();
    expect(screen.queryByText("Contato")).not.toBeInTheDocument();
    const accepts = [...container.ownerDocument.querySelectorAll('input[type="file"]')].map((i) => i.getAttribute("accept"));
    expect(accepts[0]).toBe("image/*");
  });
});
