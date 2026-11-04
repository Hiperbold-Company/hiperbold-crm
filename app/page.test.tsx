import { describe, expect, it, vi } from "vitest";

/**
 * Hiperbold: a raiz `/` é a página de vendas (site estático em `public/site`),
 * servida pelo rewrite `beforeFiles` de `next.config.ts`, que ganha desta rota.
 * `app/page.tsx` só roda se alguém chegar a `/` sem passar pelo rewrite, e então
 * manda para o painel; o proxy leva o visitante sem sessão ao login.
 *
 * O upstream trocou esta rota por uma página pública com a marca e os links
 * legais (verificação do app do Google). Aqui ela não é alcançável em produção,
 * por isso o teste mede o comportamento do fallback que de fato existe.
 */
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));

import HomePage from "./page";

describe("/ — fallback da raiz (a página de vendas vem do rewrite)", () => {
  it("manda para o painel", () => {
    expect(() => HomePage()).toThrow("NEXT_REDIRECT:/app");
  });
});
