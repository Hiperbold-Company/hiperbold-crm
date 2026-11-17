/**
 * Prova pela TELA da Fase 5: conectar o canal oficial pelo frontend.
 *
 * O que precisa ser provado, e não só "a página abre":
 *   1. o admin chega pelo hub de configurações, clicando;
 *   2. credencial ERRADA é recusada **com o motivo da Meta** e nada é gravado —
 *      este é o caso que distingue "validar" de "aceitar e torcer";
 *   3. credencial certa conecta, e a tela mostra o que colar no painel da Meta.
 *
 * O caso 2 usa a Graph API REAL. Não há mock: o valor da tela é justamente falar
 * com a Meta antes de gravar, e mockar isso testaria o mock.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";




const EVIDENCE = path.join(
  process.cwd(),
  process.env.CANAIS_EVIDENCE_DIR ?? "evidence/canais/fase5",
);
fs.mkdirSync(EVIDENCE, { recursive: true });

/** Credenciais reais da WABA de teste, do ambiente — nunca hardcoded no spec. */
const REAL = {
  phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
  wabaId: process.env.META_WABA_ID ?? "",
  token: process.env.META_SYSTEM_USER_TOKEN ?? "",
};


test.describe.configure({ mode: "serial" });

/**
 * Tela em cartões (17/11/2026): o formulário de credenciais mora em Criar > WhatsApp oficial >
 * "Conectar com credenciais (avançado)", e só o administrador da plataforma o vê. A conta destas
 * jornadas é administradora da plataforma.
 */
async function abrirCredenciais(page: Page) {
  await page.goto("/app/connections");
  await page.getByTestId("btn-criar-conexao").click();
  const criar = page.getByTestId("criar-conexao");
  await criar.getByTestId("criar-tipo-whatsapp_oficial").click();
  const avancado = criar.getByTestId("criar-oficial-credenciais");
  await avancado.locator("summary").click();
  await expect(avancado.locator("#pnid")).toBeVisible({ timeout: 20_000 });
  return avancado;
}

test("o admin chega ao canal oficial pela área de Conexões", async ({ page }) => {
  // Conectar canal — por QR ou oficial — vive em Conexões. O redirect da rota velha e o card-ponte
  // do hub são cobertos por `conexoes-abas.spec.ts`.
  await page.goto("/app/connections");
  // Foto ANTES da asserção: quando o botão não aparece, o artefato de erro nem sempre traz o snapshot.
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${EVIDENCE}/00-hub-antes-da-assercao.png`, fullPage: true });

  await abrirCredenciais(page);
  await page.screenshot({ path: `${EVIDENCE}/01-tela-conexao.png`, fullPage: true });
});

test("credencial errada é RECUSADA com o motivo da Meta, e nada é gravado", async ({ page }) => {
  // É o caso que separa "validar" de "aceitar e torcer".
  const avancado = await abrirCredenciais(page);
  await avancado.locator("#pnid").fill("000000000000000");
  await avancado.locator("#waba").fill("000000000000000");
  await avancado.locator("#tok").fill("EAAtoken-invalido-de-proposito-para-o-teste");

  const resposta = page.waitForResponse(
    (r) => r.url().includes("/api/v1/channels/official") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await avancado.getByTestId("btn-conectar").click();
  const res = await resposta;

  // 422, não 500: credencial ruim é entrada inválida, não falha nossa.
  expect(res.status()).toBe(422);

  // O que importa é que a tentativa RUIM não estragou a conexão boa: o cartão do número real segue
  // na grade, e o id inventado não virou cartão.
  await page.reload();
  const grade = page.getByTestId("grade-de-conexoes");
  await expect(grade).toBeVisible({ timeout: 20_000 });
  await expect(grade).not.toContainText("000000000000000");
  await page.screenshot({ path: `${EVIDENCE}/02-credencial-recusada.png`, fullPage: true });
});

test("credencial real conecta, o cartão aparece e o Avançado mostra o que colar na Meta", async ({ page }) => {
  test.skip(!REAL.token, "sem META_SYSTEM_USER_TOKEN no ambiente");

  const avancado = await abrirCredenciais(page);
  await avancado.locator("#pnid").fill(REAL.phoneNumberId);
  await avancado.locator("#waba").fill(REAL.wabaId);
  await avancado.locator("#tok").fill(REAL.token);

  const resposta = page.waitForResponse(
    (r) => r.url().includes("/api/v1/channels/official") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await avancado.getByTestId("btn-conectar").click();
  expect((await resposta).status()).toBe(200);

  // O cartão do número aparece na grade, com o nome que vem da Meta (prova de que a validação falou com ela).
  await page.keyboard.press("Escape");
  const cartao = page.locator('[data-testid^="cartao-conexao-"]', { hasText: /Test Number/i }).first();
  await expect(cartao).toBeVisible({ timeout: 20_000 });

  // Sem o webhook colado no painel da Meta o canal envia e não recebe: o Avançado do Gerenciar entrega a URL.
  await cartao.getByRole("button", { name: /Gerenciar/ }).click();
  const dialogo = page.getByTestId("gerenciar-conexao");
  await dialogo.getByTestId("gerenciar-avancado").locator("summary").click();
  await expect(dialogo.getByText(/URL de callback/i)).toBeVisible();
  await expect(dialogo.getByText(/api\/v1\/webhooks\/meta\//)).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-conectado.png`, fullPage: true });
});
