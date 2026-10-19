/**
 * A caixa de busca de Contatos segue a URL sem nunca atropelar o que a pessoa digita.
 * O `router.replace` é assíncrono: a URL devolve valores ANTIGOS depois de a pessoa ter digitado mais.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBuscaNaUrl } from "@/hooks/contacts/useBuscaNaUrl";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function montar(inicial = "") {
  const aplicar = vi.fn();
  const r = renderHook(({ url }) => useBuscaNaUrl(url, aplicar, 250), { initialProps: { url: inicial } });
  return { ...r, aplicar };
}

describe("useBuscaNaUrl", () => {
  it("digitar espera a pausa e só então escreve na URL", () => {
    const { result, aplicar } = montar();
    act(() => result.current.setTexto("ana"));
    act(() => vi.advanceTimersByTime(200));
    expect(aplicar).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60));
    expect(aplicar).toHaveBeenCalledExactlyOnceWith("ana");
  });

  it("URL que responde ATRASADA não reescreve a caixa no meio da digitação", () => {
    const { result, rerender, aplicar } = montar();
    act(() => result.current.setTexto("a"));
    act(() => vi.advanceTimersByTime(260)); // envia "a"
    act(() => result.current.setTexto("ab"));
    act(() => vi.advanceTimersByTime(260)); // envia "ab"
    act(() => result.current.setTexto("abc")); // a pessoa segue digitando...
    expect(aplicar.mock.calls.map((c) => c[0])).toEqual(["a", "ab"]);

    // ...e só agora a URL devolve o eco do PRIMEIRO envio, depois o do segundo
    rerender({ url: "a" });
    expect(result.current.texto).toBe("abc");
    rerender({ url: "ab" });
    expect(result.current.texto).toBe("abc");

    act(() => vi.advanceTimersByTime(260));
    expect(aplicar).toHaveBeenLastCalledWith("abc");
    rerender({ url: "abc" });
    expect(result.current.texto).toBe("abc");
  });

  it("eco que pula um envio intermediário também é eco", () => {
    const { result, rerender } = montar();
    act(() => result.current.setTexto("a"));
    act(() => vi.advanceTimersByTime(260));
    act(() => result.current.setTexto("ab"));
    act(() => vi.advanceTimersByTime(260));
    act(() => result.current.setTexto("abx"));
    rerender({ url: "ab" }); // a URL foi direto para "ab"
    expect(result.current.texto).toBe("abx");
  });

  it("mudança de FORA (voltar, link colado) reescreve a caixa", () => {
    const { result, rerender, aplicar } = montar("antiga");
    rerender({ url: "outra coisa" });
    expect(result.current.texto).toBe("outra coisa");
    // e não devolve o valor para a URL como se fosse digitação
    act(() => vi.advanceTimersByTime(300));
    expect(aplicar).not.toHaveBeenCalled();
  });

  it("apagar a caixa limpa a URL", () => {
    const { result, rerender, aplicar } = montar("x");
    act(() => result.current.setTexto(""));
    act(() => vi.advanceTimersByTime(260));
    expect(aplicar).toHaveBeenCalledWith("");
    rerender({ url: "" });
    expect(result.current.texto).toBe("");
  });

  it("limpar() zera a caixa na hora, sem esperar a URL, e não reenvia", () => {
    const { result, aplicar } = montar("x");
    act(() => result.current.limpar());
    expect(result.current.texto).toBe("");
    act(() => vi.advanceTimersByTime(300));
    expect(aplicar).not.toHaveBeenCalled();
  });
});
