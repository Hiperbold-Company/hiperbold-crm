/**
 * O `AlertDialogAction` nasce `data-variant="primary"`; os usos destrutivos
 * (`buttonVariants({ variant: "destructive" })`) passam `data-variant="destructive"`
 * para o CSS do redesign não os pintar como primário. O `{...props}` vem depois.
 */
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { AlertDialog, AlertDialogAction } from "@/components/ui/alert-dialog";

const USOS = [
  "app/app/ai/followups/_components/QueueTab.tsx",
  "app/app/ai/followups/enrollments/[id]/_components/DossieDoFollowup.tsx",
  "app/app/kanban/_client.tsx",
  "components/extensions/InstalledExtensionCard.tsx",
  "components/kanban/KanbanCardActions.tsx",
];

describe("AlertDialogAction: data-variant", () => {
  it("padrão é primary e o chamador sobrescreve para destructive", () => {
    render(
      <AlertDialog open>
        <AlertDialogAction>padrao</AlertDialogAction>
        <AlertDialogAction data-variant="destructive">perigo</AlertDialogAction>
      </AlertDialog>,
    );
    expect(screen.getByText("padrao").getAttribute("data-variant")).toBe("primary");
    expect(screen.getByText("perigo").getAttribute("data-variant")).toBe("destructive");
  });

  it("todo AlertDialogAction com buttonVariants destrutivo declara data-variant destructive", () => {
    for (const arquivo of USOS) {
      const fonte = fs.readFileSync(arquivo, "utf8");
      const aberturas = fonte.match(/<AlertDialogAction[\s\S]*?>/g) ?? [];
      const destrutivos = aberturas.filter((a) => a.includes('buttonVariants({ variant: "destructive" })'));
      expect(destrutivos.length, arquivo).toBeGreaterThan(0);
      for (const a of destrutivos) expect(a, arquivo).toContain('data-variant="destructive"');
    }
  });
});
