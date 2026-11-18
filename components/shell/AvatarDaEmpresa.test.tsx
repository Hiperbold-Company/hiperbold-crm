import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AvatarDaEmpresa, matizDoNome } from "./AvatarDaEmpresa";

describe("AvatarDaEmpresa", () => {
  it("com logo: imagem redonda de 32px com recorte central", () => {
    const { container } = render(
      <AvatarDaEmpresa nome="Clínica da Ana" logoUrl="http://s/storage/v1/object/public/brand-logos/x.png" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("http://s/storage/v1/object/public/brand-logos/x.png");
    expect(img?.className).toContain("rounded-full");
    expect(img?.className).toContain("object-cover");
    expect(img?.style.width).toBe("32px");
    expect(img?.style.height).toBe("32px");
  });

  it("sem logo: iniciais sobre uma cor, sem imagem", () => {
    const { container } = render(<AvatarDaEmpresa nome="Clínica da Ana" logoUrl={null} />);
    expect(container.querySelector("img")).toBeNull();
    const circulo = container.querySelector("[data-avatar-da-empresa='iniciais']") as HTMLElement;
    expect(circulo.textContent).toBe("CA");
    expect(circulo.className).toContain("rounded-full");
    expect(circulo.style.backgroundColor).not.toBe("");
  });

  it("a cor é estável por nome", () => {
    expect(matizDoNome("Loja do Beto")).toBe(matizDoNome("Loja do Beto"));
    expect(matizDoNome("Loja do Beto")).toBeGreaterThanOrEqual(0);
    expect(matizDoNome("Loja do Beto")).toBeLessThan(360);
  });
});
