/**
 * `AlertDialogAction` recebe `variant` ("primary" | "destructive"): dela saem a
 * classe e o `data-variant`, como em `Button`. Chamador nenhum passa
 * `data-variant` à mão nem monta `buttonVariants` destrutivo na className.
 */
import { render, screen } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { AlertDialog, AlertDialogAction } from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Devolve as violações (texto da abertura) de `<AlertDialogAction ...>` em `fonte`. */
function violacoes(fonte: string): string[] {
  const sf = ts.createSourceFile("x.tsx", fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ruins: string[] = [];
  const visita = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (n.tagName.getText(sf) === "AlertDialogAction") {
        const abertura = n.getText(sf);
        const manual = n.attributes.properties.some(
          (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "data-variant",
        );
        const classe = n.attributes.properties.some(
          (p) =>
            ts.isJsxAttribute(p) &&
            p.name.getText(sf) === "className" &&
            /buttonVariants\(\s*\{\s*variant:\s*["']destructive["']/.test(p.getText(sf)),
        );
        if (manual || classe) ruins.push(abertura);
      }
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return ruins;
}

describe("AlertDialogAction: variant", () => {
  it("sem variant: data-variant primary e classe primária", () => {
    render(
      <AlertDialog open>
        <AlertDialogAction>padrao</AlertDialogAction>
      </AlertDialog>,
    );
    const el = screen.getByText("padrao");
    expect(el.getAttribute("data-variant")).toBe("primary");
    expect(el.className).toBe(cn(buttonVariants()));
    expect(el.className).toContain("bg-accent");
  });

  it("variant destructive: data-variant destructive e classe destrutiva", () => {
    render(
      <AlertDialog open>
        <AlertDialogAction variant="destructive">perigo</AlertDialogAction>
      </AlertDialog>,
    );
    const el = screen.getByText("perigo");
    expect(el.getAttribute("data-variant")).toBe("destructive");
    expect(el.className).toBe(cn(buttonVariants({ variant: "destructive" })));
    expect(el.className).toContain("bg-error");
    expect(el.className).not.toContain("bg-accent ");
  });

  it("className do chamador vem depois", () => {
    render(
      <AlertDialog open>
        <AlertDialogAction variant="destructive" className="w-full">
          largo
        </AlertDialogAction>
      </AlertDialog>,
    );
    expect(screen.getByText("largo").className).toContain("w-full");
  });
});

describe("varredura: ninguém passa data-variant nem buttonVariants destrutivo ao AlertDialogAction", () => {
  it("o detector reprova um caso ruim com onClick antes do className", () => {
    const ruim = `const a = (
      <AlertDialogAction onClick={() => x()} className={buttonVariants({ variant: "destructive" })}>ok</AlertDialogAction>
    );`;
    expect(violacoes(ruim)).toHaveLength(1);
    const ruim2 = `const a = (<AlertDialogAction onClick={() => x()} data-variant="destructive">ok</AlertDialogAction>);`;
    expect(violacoes(ruim2)).toHaveLength(1);
    const bom = `const a = (<AlertDialogAction variant="destructive" onClick={() => x()}>ok</AlertDialogAction>);`;
    expect(violacoes(bom)).toHaveLength(0);
  });

  it("nenhum arquivo de produção viola", () => {
    const lista = execFileSync(
      "git",
      ["grep", "-l", "AlertDialogAction", "--", "app", "components", "lib"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f && !/\.test\.tsx?$/.test(f) && f !== "components/ui/alert-dialog.tsx");
    expect(lista.length).toBeGreaterThan(10);
    const ruins = lista.flatMap((f) => violacoes(fs.readFileSync(f, "utf8")).map((v) => `${f}: ${v}`));
    expect(ruins).toEqual([]);
  });
});
