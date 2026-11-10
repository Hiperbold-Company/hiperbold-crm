/**
 * Automações — tela única (lote 5): a lista de /app/automacoes junta automações, follow-ups e
 * regras antigas; abrir uma regra antiga conversível mostra a pré-visualização em blocos e
 * publicar desliga a regra e liga a automação nova; "Usar um modelo" cria um rascunho que abre no
 * editor. Dirige a TELA, como o dono da agência faria. O banco é usado só para semear a regra
 * antiga (a tela antiga de regras tem seu próprio teste) e para conferir o desfecho.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test } from "./helpers/test";

const CREDS_PATH = ".e2e-creds.json";
const PRAZO = 60_000;

function loadCreds(): CredsE2E {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsE2E;
}

const creds = loadCreds();
const orgId = (creds as CredsE2E & { org_id?: string }).org_id ?? "";
const envLocal = carregarEnvLocal();
const banco = createClient(
  envLocal.NEXT_PUBLIC_SUPABASE_URL ?? "",
  envLocal.SUPABASE_SERVICE_ROLE_KEY ?? "",
  {
    auth: { autoRefreshToken: false, persistSession: false },
  },
);

async function semearRegra(nome: string, actions: unknown[]): Promise<string> {
  const { data, error } = await banco
    .from("automation_rules")
    .insert({
      organization_id: orgId,
      name: nome,
      trigger_event: "lead.created",
      conditions: [],
      actions,
      is_active: true,
    })
    .select("id")
    .single();
  expect(error, "semear a regra antiga").toBeNull();
  return (data as { id: string }).id;
}

test.describe("Automações — tela única", () => {
  test.setTimeout(4 * 60_000);

  test("a lista mostra os três tipos; regra antiga vira automação ao publicar", async ({
    page,
  }) => {
    const carimbo = Date.now().toString(36);
    const conversivel = await semearRegra(`Etiqueta nova ${carimbo}`, [
      { type: "add_tag", config: { tags: ["novo"] } },
    ]);
    const naoConversivel = await semearRegra(`Email ${carimbo}`, [
      { type: "send_email", config: { destinatario: "contato", assunto: "Oi", corpo: "Oi" } },
    ]);

    await loginComoAdmin(page, creds);
    await page.goto("/app/automacoes");
    await expect(page.getByRole("heading", { name: "Automações", level: 1 })).toBeVisible({
      timeout: PRAZO,
    });

    // Os tipos em palavra simples, com filtro e busca.
    await page.getByTestId("busca-de-automacoes").fill(carimbo);
    const lista = page.getByTestId("lista-de-automacoes");
    await expect(lista.getByTestId("linha-regra")).toHaveCount(2);
    await expect(
      lista.getByText("Regra antiga — continua funcionando; abra na tela antiga."),
    ).toBeVisible();
    await page.getByTestId("busca-de-automacoes").fill("");
    await page.getByTestId("filtro-tipo-followup").click();
    await expect(page.getByTestId("filtro-tipo-followup")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("filtro-tipo-todos").click();

    // A não conversível abre a explicação e o caminho da tela antiga.
    await page.goto(`/app/automacoes/converter/${naoConversivel}`);
    await expect(page.getByTestId("regra-nao-conversivel")).toBeVisible({ timeout: PRAZO });
    await expect(page.getByRole("link", { name: "Abrir na tela antiga" })).toHaveAttribute(
      "href",
      /tab=rules/,
    );

    // A conversível: pré-visualização em blocos, aviso, publicar.
    await page.goto("/app/automacoes");
    await page.getByTestId("busca-de-automacoes").fill(`Etiqueta nova ${carimbo}`);
    await lista.getByRole("link", { name: new RegExp(`Etiqueta nova ${carimbo}`) }).click();
    await expect(page.getByTestId("blocos-da-conversao")).toBeVisible({ timeout: PRAZO });
    await expect(page.getByText("Ao publicar, a regra antiga é desligada")).toBeVisible();
    await page.getByTestId("publicar-conversao").click();
    await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]{36}$/, { timeout: PRAZO });
    const pointerId = page.url().split("/").pop()!;

    const { data: regra } = await banco
      .from("automation_rules")
      .select("is_active, migrated_to_pointer_id")
      .eq("organization_id", orgId)
      .eq("id", conversivel)
      .single();
    expect(regra).toMatchObject({ is_active: false, migrated_to_pointer_id: pointerId });
    const { data: ponteiro } = await banco
      .from("followup_flow_pointers")
      .select("status, surface")
      .eq("organization_id", orgId)
      .eq("id", pointerId)
      .single();
    expect(ponteiro).toMatchObject({ status: "active", surface: "automacao" });

    // Na lista ela aparece uma vez só, como automação.
    await page.goto("/app/automacoes");
    await page.getByTestId("busca-de-automacoes").fill(`Etiqueta nova ${carimbo}`);
    await expect(lista.locator("li")).toHaveCount(1);
    await expect(lista.getByTestId("linha-automacao")).toHaveCount(1);
  });

  test("Usar um modelo cria um rascunho que abre no editor", async ({ page }) => {
    await loginComoAdmin(page, creds);
    await page.goto("/app/automacoes");
    await page.getByTestId("usar-modelo-de-automacao").first().click();
    await page.getByTestId("modelo-boas_vindas").check();
    await page.getByTestId("criar-de-modelo").click();
    await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]{36}$/, { timeout: PRAZO });
    const pointerId = page.url().split("/").pop()!;
    const { data } = await banco
      .from("followup_flow_pointers")
      .select("status, surface, active_version_id")
      .eq("organization_id", orgId)
      .eq("id", pointerId)
      .single();
    expect(data).toMatchObject({ status: "draft", surface: "automacao", active_version_id: null });
  });
});
