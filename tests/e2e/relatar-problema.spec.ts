/**
 * "RELATAR PROBLEMA" PELA TELA (migration 1018) — a jornada inteira, de quem relata e de quem lê.
 *
 * O que esta spec prova:
 *
 *  1. Computador (1280x800): a aba do inseto fica presa à borda direita, dentro da viewport na
 *     vertical e sem cobrir o botão de enviar do chat (medido por getBoundingClientRect).
 *  2. O clique abre o modal com a pergunta do print (Sim/Não) e o texto de apoio; com "Sim" a
 *     miniatura é a captura REAL (modern-screenshot), com tamanho; sem descrição o envio é
 *     recusado; com ela, o toast "Recebemos o seu relato".
 *  3. Celular (390x844): a aba não aparece.
 *  4. O dono do servidor, em /admin/relatos, vê o relato com a descrição; o detalhe carrega o
 *     print pela URL assinada (naturalWidth > 0); a troca para "Em andamento" persiste depois
 *     de recarregar.
 *
 * Uma pessoa só: o `dono` (admin de organização E dono do servidor). Um login por arquivo — o
 * TOTP aceita cada código uma vez, e um segundo login esperaria a próxima janela.
 *
 * Não prova: o limite de 10 relatos por hora e a recusa de print inválido (rota e `regras`,
 * testadas em unit).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { lerCreds, loginComoDono } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "relatar-problema");
const SUFIXO = Date.now().toString(36);
const DESCRICAO = `O botão de salvar não responde na tela de teste ${SUFIXO}`;

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 }, locale: "pt-BR" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const contexto = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "pt-BR",
  });
  page = await contexto.newPage();
  await loginComoDono(page, lerCreds());
});

test.afterAll(async () => {
  await page?.context().close();
});

test("computador: a aba fica na borda direita, dentro da tela e sem cobrir o enviar do chat", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app/inbox");
  const aba = page.getByTestId("relatar-problema");
  await expect(aba).toBeVisible();

  const medidas = await aba.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      direita: r.right,
      esquerda: r.left,
      topo: r.top,
      base: r.bottom,
      largura: window.innerWidth,
      altura: window.innerHeight,
    };
  });
  // A aba é empurrada 8 px para fora da borda e desliza ao passar o mouse: a borda direita nunca
  // fica aquém da viewport.
  expect(medidas.direita).toBeGreaterThanOrEqual(medidas.largura - 2);
  expect(medidas.esquerda).toBeLessThan(medidas.largura);
  expect(medidas.topo).toBeGreaterThanOrEqual(0);
  expect(medidas.base).toBeLessThanOrEqual(medidas.altura);

  // Se houver uma conversa aberta com o compositor na tela, a aba não cobre o botão de enviar.
  const composer = page.getByTestId("composer");
  if (await composer.count()) {
    const enviar = composer.getByRole("button", { name: /^(Enviar|Agendar)$/ });
    if (await enviar.count()) {
      const cx = await enviar.first().boundingBox();
      const ax = await aba.boundingBox();
      expect(cx && ax).toBeTruthy();
      const sobrepoe =
        cx!.x < ax!.x + ax!.width &&
        cx!.x + cx!.width > ax!.x &&
        cx!.y < ax!.y + ax!.height &&
        cx!.y + cx!.height > ax!.y;
      expect(sobrepoe, "a aba cobre o botão de enviar do chat").toBe(false);
    }
  }
  await foto(page, "01-aba-na-borda-direita");
});

test("computador: modal, print real, envio bloqueado sem descrição e toast ao enviar", async () => {
  await page.goto("/app/inicio");
  const aba = page.getByTestId("relatar-problema");
  await expect(aba).toBeVisible();
  await aba.click();

  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Descreva o problema encontrado")).toBeVisible();
  await expect(modal.getByText("Podemos incluir um print da tela atual?")).toBeVisible();
  await expect(modal.getByLabel("Sim")).toBeChecked();
  await expect(modal.getByLabel("Não")).not.toBeChecked();
  await expect(
    modal.getByText("O seu print-screen nos ajudará a resolver o problema mais rapidamente"),
  ).toBeVisible();

  // A miniatura é a captura de verdade: a imagem decodifica e tem tamanho.
  const miniatura = modal.getByRole("img", { name: "Print da tela" });
  await expect(miniatura).toBeVisible();
  await expect
    .poll(() => miniatura.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  expect(await miniatura.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBeGreaterThan(0);

  // "Não" esconde a miniatura; "Sim" a traz de volta.
  await modal.getByLabel("Não").check();
  await expect(miniatura).toHaveCount(0);
  await modal.getByLabel("Sim").check();
  await expect(miniatura).toBeVisible();
  await foto(page, "02-modal-com-print");

  // Sem descrição o envio é recusado: o modal fica aberto, com o aviso, e nada de toast.
  await modal.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Descreva o problema com 10 a 2000 caracteres.");
  await expect(modal).toBeVisible();
  await expect(page.getByText("Recebemos o seu relato")).toHaveCount(0);
  await foto(page, "03-envio-bloqueado-sem-descricao");

  // Com a descrição, envia e confirma.
  await modal.getByLabel("Descreva o problema encontrado").fill(DESCRICAO);
  const envio = page.waitForResponse(
    (r) => r.url().includes("/api/v1/bug-reports") && r.request().method() === "POST",
  );
  await modal.getByRole("button", { name: "Enviar", exact: true }).click();
  expect((await envio).status()).toBe(201);
  await expect(page.getByText("Recebemos o seu relato")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await foto(page, "04-relato-enviado");
});

test("celular: a aba não aparece", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/inicio");
  // A tela já carregou antes de afirmar ausência.
  await expect(page.locator("main").first()).toBeVisible();
  await expect(page.getByTestId("relatar-problema")).toBeHidden();
  await foto(page, "05-celular-sem-aba");
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("admin da plataforma: o relato aparece com o print e o status em andamento persiste", async () => {
  await page.goto("/admin/relatos");
  await expect(page.getByRole("heading", { name: "Relatos de problema" })).toBeVisible();

  const linha = page.getByRole("row").filter({ hasText: DESCRICAO });
  await expect(linha).toBeVisible({ timeout: 15_000 });
  await expect(linha.getByRole("cell", { name: "Sim", exact: true })).toBeVisible(); // tem print
  await foto(page, "06-admin-lista-de-relatos");

  // Clica na DESCRIÇÃO, não no centro da linha: o centro cai no link da tela relatada, que abre
  // outra aba (e para a propagação) em vez do detalhe.
  await linha.getByRole("cell").filter({ hasText: DESCRICAO.slice(0, 20) }).click();
  const detalhe = page.getByRole("dialog");
  await expect(detalhe.getByText(DESCRICAO)).toBeVisible();

  const print = detalhe.getByRole("img", { name: "Print da tela" });
  await expect(print).toBeVisible();
  await expect
    .poll(() => print.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await foto(page, "07-admin-detalhe-com-print");

  await detalhe.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Em andamento" }).click();
  await detalhe.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Relato atualizado.")).toBeVisible();

  // Persistiu: recarrega, o relato saiu de "Novo" e está em "Em andamento".
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: DESCRICAO })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Em andamento" }).click();
  const andamento = page.getByRole("row").filter({ hasText: DESCRICAO });
  await expect(andamento).toBeVisible({ timeout: 15_000 });
  await expect(andamento.getByText("Em andamento")).toBeVisible();
  await foto(page, "08-admin-em-andamento-depois-de-recarregar");
});
