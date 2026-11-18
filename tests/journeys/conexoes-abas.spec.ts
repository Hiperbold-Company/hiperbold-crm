/**
 * Conexões: um lugar só para conectar e cuidar dos canais, em cartões (17/11/2026).
 *
 * O defeito que esta jornada trava: conectar por QR ficava em `/app/connections`,
 * conectar o número OFICIAL ficava em Configurações, e os templates numa terceira
 * tela. Desde a tela em cartões: uma grade com todas as conexões, "Criar" para uma
 * nova (o tipo se escolhe lá dentro) e "Gerenciar" para cuidar de cada uma, com os
 * Templates da Meta DENTRO do diálogo da conta oficial.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const EVIDENCE = path.join(process.cwd(), "evidence/canais/conexoes");
fs.mkdirSync(EVIDENCE, { recursive: true });

/** Sem conta oficial semeada o link abre o Criar da oficial; com ela, o Gerenciar. Os dois são o lugar certo. */
function destinoDaOficial(page: Page) {
  return page.getByTestId("gerenciar-conexao").or(page.getByTestId("criar-conteudo-whatsapp_oficial"));
}

test("uma grade só, com Criar e os tipos lado a lado", async ({ page }) => {
  await page.goto("/app/connections");
  await expect(page.getByRole("tab", { name: /API Oficial/i })).toHaveCount(0);
  await expect(page.getByTestId("btn-criar-conexao")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("grade-de-conexoes").or(page.getByTestId("conexoes-vazio"))).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/01-grade.png`, fullPage: true });

  await page.getByTestId("btn-criar-conexao").click();
  const criar = page.getByTestId("criar-conexao");
  await expect(criar.getByTestId("criar-tipo-whatsapp_oficial")).toBeVisible();
  await expect(criar.getByTestId("criar-tipo-whatsapp_qr")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-criar.png`, fullPage: true });
});

test("o Gerenciar de uma conexão oficial tem os Templates da Meta dentro do diálogo", async ({ page }) => {
  await page.goto("/app/connections");
  const cartaoOficial = page.locator('[data-testid^="cartao-conexao-"]', { hasText: "WhatsApp API Oficial" }).first();
  test.skip((await cartaoOficial.count()) === 0, "instalação sem conexão oficial semeada");
  await cartaoOficial.getByRole("button", { name: /Gerenciar/ }).click();

  const dialogo = page.getByTestId("gerenciar-conexao");
  await expect(dialogo).toBeVisible();
  const aba = dialogo.getByRole("tab", { name: /Templates da Meta/i });
  await aba.click();
  await expect(aba).toHaveAttribute("data-state", "active");
  await page.screenshot({ path: `${EVIDENCE}/03-oficial-templates.png`, fullPage: true });
});

test("o link antigo de aba abre onde deveria", async ({ page }) => {
  // É o que faz os redirects das rotas antigas funcionarem.
  await page.goto("/app/connections?aba=oficial&sub=templates");
  await expect(destinoDaOficial(page)).toBeVisible({ timeout: 20_000 });
});

test("quem tinha o link antigo salvo não cai em 404", async ({ page }) => {
  await page.goto("/app/settings/canal-oficial");
  await page.waitForURL(/\/app\/connections/);
  await expect(destinoDaOficial(page)).toBeVisible({ timeout: 20_000 });

  await page.goto("/app/settings/templates");
  await page.waitForURL(/\/app\/connections/);
  await expect(destinoDaOficial(page)).toBeVisible({ timeout: 20_000 });
});

test("o card em Configurações leva ao MESMO lugar, não a um segundo", async ({ page }) => {
  // Se este caso falhar porque o card sumiu, tudo bem; se falhar porque ele leva a outra tela, o problema voltou.
  await page.goto("/app/settings");
  const card = page.getByRole("link", { name: /Canal oficial/i });
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL(/\/app\/connections/);
  await expect(destinoDaOficial(page)).toBeVisible({ timeout: 20_000 });
});
