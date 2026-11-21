import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvedorDoRedesign, useRedesign } from "./contexto";

function Mostra() {
  return <span>{useRedesign() ? "ligado" : "desligado"}</span>;
}

describe("useRedesign", () => {
  it("fora do provedor é desligado", () => {
    expect(renderToStaticMarkup(<Mostra />)).toContain("desligado");
  });
  it("segue o valor do provedor", () => {
    expect(
      renderToStaticMarkup(
        <ProvedorDoRedesign ligado>
          <Mostra />
        </ProvedorDoRedesign>,
      ),
    ).toContain(">ligado<");
    expect(
      renderToStaticMarkup(
        <ProvedorDoRedesign ligado={false}>
          <Mostra />
        </ProvedorDoRedesign>,
      ),
    ).toContain("desligado");
  });
});
