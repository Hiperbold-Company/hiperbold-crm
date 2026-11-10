/**
 * Automações — tela única (lote 5): a lista de /app/automacoes junta automações, follow-ups e
 * regras antigas; abrir uma regra antiga conversível mostra a pré-visualização em blocos e
 * publicar desliga a regra e liga a automação nova; "Usar um modelo" cria um rascunho que abre no
 * editor. Dirige a TELA, como o dono da agência faria. O banco é usado só para semear a regra
 * antiga (a tela antiga de regras tem seu próprio teste) e para conferir o desfecho.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test } from "./helpers/test";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote5";
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

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function semearPonteiro(nome: string, surface: "followup" | "automacao"): Promise<void> {
  const { error } = await banco
    .from("followup_flow_pointers")
    .insert({ organization_id: orgId, name: nome, status: "draft", surface });
  expect(error, `semear o ${surface}`).toBeNull();
}

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
  test.setTimeout(240_000);

  test("a lista mostra os três tipos; regra antiga vira automação ao publicar", async ({
    page,
  }) => {
    const carimbo = Date.now().toString(36);
    const conversivel = await semearRegra(`Etiqueta nova ${carimbo}`, [
      { type: "add_tag", config: { tags: ["vip"] } },
    ]);
    const naoConversivel = await semearRegra(`Email ${carimbo}`, [
      { type: "send_email", config: { destinatario: "contato", assunto: "Oi", corpo: "Oi" } },
    ]);

    await semearPonteiro(`Follow-up ${carimbo}`, "followup");
    await semearPonteiro(`Automação ${carimbo}`, "automacao");

    await loginComoAdmin(page, creds);
    await page.goto("/app/automacoes");
    await expect(page.getByRole("heading", { name: "Automações", level: 1 })).toBeVisible({
      timeout: PRAZO,
    });

    // Os tipos em palavra simples, com filtro e busca.
    await page.getByTestId("busca-de-automacoes").fill(carimbo);
    const lista = page.getByTestId("lista-de-automacoes");
    await expect(lista.getByTestId("linha-regra")).toHaveCount(2);
    await expect(lista.getByTestId("linha-followup")).toHaveCount(1);
    await expect(lista.getByTestId("linha-automacao")).toHaveCount(1);
    await foto(page, "01-lista-unica-com-os-tres-tipos");
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
    await foto(page, "02-regra-antiga-nao-conversivel");
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
    await foto(page, "03-previa-da-conversao-com-o-aviso");
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
    await foto(page, "04-depois-de-publicar-so-a-automacao-nova");

    // A regra antiga, na tela antiga, aparece desligada.
    await page.goto("/app/webhooks?tab=rules");
    await expect(page.getByText(`Etiqueta nova ${carimbo}`).first()).toBeVisible({ timeout: PRAZO });
    await foto(page, "05-tela-antiga-com-a-regra-desligada");
  });

  test("Usar um modelo cria um rascunho que abre no editor", async ({ page }) => {
    // O modelo nasce com nome fixo e o produto recusa nome repetido: limpa o rascunho de uma
    // rodada anterior no mesmo banco, para a spec poder rodar de novo.
    const { error: limpar } = await banco
      .from("followup_flow_pointers")
      .delete()
      .eq("organization_id", orgId)
      .eq("surface", "automacao")
      .eq("name", "Boas-vindas ao novo contato");
    expect(limpar, "limpar o rascunho do modelo de uma rodada anterior").toBeNull();
    await loginComoAdmin(page, creds);
    await page.goto("/app/automacoes");
    await page.getByTestId("usar-modelo-de-automacao").first().click();
    await page.getByTestId("modelo-boas_vindas").check();
    await foto(page, "06-dialogo-usar-um-modelo");
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
    // O editor carrega depois da URL: sem esperar o fluxo desenhado a foto sairia em esqueleto.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: PRAZO });
    await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible();
    await foto(page, "07-rascunho-aberto-no-editor");
  });
});
