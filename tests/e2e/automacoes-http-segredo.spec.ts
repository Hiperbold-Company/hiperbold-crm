/**
 * AUTOMAÇÕES — LOTE 4: bloco "Requisição HTTP" com chave secreta, provado pela tela.
 *
 *   Início (Manual) → Requisição HTTP (GET, cabeçalho Authorization com a chave
 *   "token_meta") → Deu certo / Falhou → Fim
 *
 * O que este arquivo prova, clicando:
 *   1. a porta: Automações › "Chaves secretas"; a chave "token_meta" é salva e
 *      depois aparece só como ••••final — o valor não volta à página;
 *   2. o bloco sai da paleta (grupo Integrações); no formulário, um endereço
 *      http://127.0.0.1 (o receptor real deste teste) mostra o aviso legível e o
 *      publish é recusado;
 *   3. com o endereço do metadata da nuvem (https://169.254.169.254/...), a
 *      automação publica, é iniciada pelo "Testar com um contato" e o bloco sai
 *      por "Falhou" com "endereço recusado" na tela de Execuções — o receptor
 *      HTTP real recebeu ZERO requisições, e a página não mostra o token.
 *
 * O caminho POSITIVO (o cabeçalho com o token chega e o campo mapeado é
 * gravado) NÃO roda aqui, de propósito: o destino é escolhido pela ORGANIZAÇÃO,
 * e a régua dela exige https e IP público sem exceção — a lista de destinos
 * internos autorizados (`destinos-internos-autorizados.ts`) só vale para
 * endereço da INSTALAÇÃO (decisão 22-d). Abrir uma exceção para o e2e seria a
 * brecha em produção. Quem prova a chegada é
 * `lib/automacoes/efeitos/http.test.ts` ("pelo fetch seguro de produção, contra
 * um receptor HTTP real"), com o fetch de produção e só o DNS/TLS trocados.
 * Mesma divisão do `vps-webhook-outbound-ssrf.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote4";
const PRAZO = 60_000;
const SEGREDO_DO_CRON = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";
const TOKEN = `tok_e2e_${Date.now()}_SEGREDO`;

function loadCreds(): CredsE2E {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsE2E;
}
const creds = loadCreds();

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function fecharPainel(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId("node-config-sheet")).toHaveCount(0, { timeout: PRAZO });
}

async function abrirNo(page: Page, nodeId: string): Promise<void> {
  await page.locator(`[data-testid="node-card-${nodeId}"]`).click();
  await expect(page.getByTestId("node-config-panel")).toBeVisible({ timeout: PRAZO });
}

async function ligar(page: Page, origem: string, destino: string, ramo?: string): Promise<void> {
  const seletor = ramo
    ? `.react-flow__node[data-id="${origem}"] .react-flow__handle.source[data-handleid="${ramo}"]`
    : `.react-flow__node[data-id="${origem}"] .react-flow__handle.source`;
  const arestas = page.locator(".react-flow__edge");
  const antes = await arestas.count();
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if ((await page.getByTestId("node-config-sheet").count()) > 0) await fecharPainel(page);
    const sBox = await page.locator(seletor).first().boundingBox();
    const tBox = await page.locator(`.react-flow__node[data-id="${destino}"] .react-flow__handle.target`).boundingBox();
    if (!sBox || !tBox) throw new Error(`handle não encontrado: ${origem}[${ramo}] -> ${destino}`);
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sBox.x + sBox.width / 2 + 5, sBox.y + sBox.height / 2 + 5, { steps: 3 });
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    if ((await arestas.count()) > antes) return;
  }
  throw new Error(`a ligação ${origem}[${ramo ?? "única"}] -> ${destino} não foi criada`);
}

async function adicionar(page: Page, tipo: string): Promise<string> {
  const antes = new Set(
    await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
  );
  await page.getByTestId(`palette-add-${tipo}`).click();
  await expect
    .poll(async () => (await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).count()) > antes.size)
    .toBe(true);
  const depois = await page
    .locator(`.react-flow__node[data-id^="${tipo}-"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  return depois.find((id) => !antes.has(id))!;
}

async function relogio(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${SEGREDO_DO_CRON}` },
    });
    expect(dreno.status(), `dreno ${i + 1}`).toBe(200);
    const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
      headers: { authorization: `Bearer ${SEGREDO_DO_CRON}` },
    });
    expect(tick.ok(), `tick ${i + 1}: ${tick.status()} ${await tick.text()}`).toBe(true);
  }
}

test.describe("Automações — lote 4: Requisição HTTP com chave secreta", () => {
  test.setTimeout(240_000);

  let receptor: http.Server;
  let porta = 0;
  let recebidas = 0;

  test.beforeAll(async () => {
    // Receptor HTTP REAL: conta toda requisição que chegar. A guarda tem de impedir qualquer uma.
    receptor = http.createServer((_req, res) => {
      recebidas += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"campaign":{"name":"não devia chegar aqui"}}');
    });
    await new Promise<void>((r) => receptor.listen(0, "127.0.0.1", r));
    porta = (receptor.address() as AddressInfo).port;
  });
  test.afterAll(async () => {
    await new Promise<void>((r) => receptor.close(() => r()));
  });

  test("chave salva mascarada; destino interno recusado com mensagem legível e zero requisições", async ({ page }) => {
    const carimbo = Date.now();
    const nomeDaChave = `token_meta_${String(carimbo).slice(-6)}`;
    await loginComoAdmin(page, creds);

    // ── 1. A porta e o cofre ──
    await page.goto("/app/automacoes");
    await page.getByTestId("link-chaves-secretas").click();
    await page.waitForURL(/\/app\/automacoes\/chaves$/, { timeout: PRAZO });
    await page.getByLabel("Nome da chave").fill(nomeDaChave);
    await page.getByLabel("Chave (token)").fill(TOKEN);
    await page.getByRole("button", { name: "Salvar chave" }).click();
    const final = page.getByTestId(`chave-${nomeDaChave}-final`);
    await expect(final).toHaveText(`••••${TOKEN.slice(-4)}`, { timeout: PRAZO });
    await expect(page.getByLabel("Chave (token)")).toHaveValue("");
    expect(await page.content(), "o token não volta à página").not.toContain(TOKEN);
    await foto(page, "01-chave-salva-mascarada");

    // ── 2. A automação ──
    await page.goto("/app/automacoes");
    await page.getByTestId("nova-automacao").click();
    await page.getByLabel("Nome").fill(`Rastrear anúncio ${carimbo}`);
    await page.getByTestId("criar-automacao").click();
    await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]+$/, { timeout: PRAZO });
    const automacaoId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
    await expect(page.getByTestId("palette-grupo-integracao")).toBeVisible();
    await zoomAte(page, 0.8);

    // O Fim que veio com a automação sai (leva a ligação Início → Fim junto).
    await abrirNo(page, "n2");
    await page.getByTestId("delete-node").click();
    const bloco = await adicionar(page, "http_request");
    const fim = await adicionar(page, "end");
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(400);

    await abrirNo(page, bloco);
    // Endereço do receptor local: o formulário avisa antes de publicar.
    await page.locator("#http-url").fill(`http://127.0.0.1:${porta}/campanha/{{contact.id}}`);
    await expect(page.getByTestId("http-form")).toContainText("O endereço precisa começar com https://.");
    await page.getByRole("button", { name: "+ Cabeçalho" }).click();
    const cab = page.getByTestId("http-cabecalho-0");
    await cab.getByLabel("Nome do cabeçalho").fill("Authorization");
    // Nome que leva credencial vira "Chave secreta" sozinho: o token escrito ficaria legível no grafo.
    await expect(page.getByTestId("http-cabecalho-0-tipo")).toHaveValue("chave");
    await page.getByTestId("http-cabecalho-0-tipo").selectOption("chave");
    await page.getByTestId("http-cabecalho-0-chave").selectOption({ label: `${nomeDaChave} (••••${TOKEN.slice(-4)})` });
    await page.getByRole("button", { name: "+ Guardar campo da resposta" }).click();
    const mapa = page.getByTestId("http-mapeamento-0");
    await mapa.getByLabel("Caminho na resposta").fill("campaign.name");
    await mapa.getByLabel("Nome da variável").fill("utm_campaign");
    await foto(page, "02-bloco-http-com-endereco-local");
    await fecharPainel(page);

    await ligar(page, "n1", bloco);
    await ligar(page, bloco, fim, "else");
    await ligar(page, bloco, fim, "erro");
    await page.getByTestId("auto-fit-flow").click();
    await page.waitForTimeout(400);

    // Publicar com http:// local é recusado com a frase do bloco.
    await page.getByTestId("publish-button").click();
    await expect(page.getByText(/o endereço precisa começar com https:\/\//).first()).toBeVisible({ timeout: PRAZO });
    await foto(page, "03-publish-recusa-http-local");

    // ── 3. O endereço do metadata da nuvem: publica, mas o motor recusa ──
    await abrirNo(page, bloco);
    await page.locator("#http-url").fill("https://169.254.169.254/latest/meta-data/{{contact.id}}");
    await expect(page.getByTestId("http-form")).not.toContainText("precisa começar com https");
    await fecharPainel(page);
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
    await expect(page.getByTestId("testar-automacao")).toBeEnabled({ timeout: PRAZO });

    const telefone = `+55119${String(carimbo).slice(-8)}`;
    const contato = await page.request.post("/api/v1/contacts", { data: { name: `Lead HTTP ${carimbo}`, phone_number: telefone } });
    expect(contato.ok(), `criar contato: ${contato.status()} ${await contato.text()}`).toBe(true);

    await page.getByTestId("testar-automacao").click();
    await page.getByTestId("testar-busca").fill(telefone.slice(-8));
    const linha = page.getByTestId("testar-resultados").locator("li").filter({ hasText: telefone.slice(-8) });
    await expect(linha).toHaveCount(1, { timeout: PRAZO });
    await linha.getByRole("button", { name: "Iniciar" }).click();
    await expect(page.getByTestId("testar-busca")).toHaveCount(0, { timeout: PRAZO });
    await relogio(page);

    await page.goto(`/app/automacoes/${automacaoId}/execucoes`);
    const execucao = page.getByTestId("lista-de-execucoes").getByRole("link", { name: new RegExp(`Lead HTTP ${carimbo}`) });
    await expect(execucao).toBeVisible({ timeout: PRAZO });
    await execucao.click();
    await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
    await expect(page.getByText(/endereço recusado/).first()).toBeVisible({ timeout: PRAZO });
    await expect(page.getByText(/Chamou GET 169\.254\.169\.254/).first()).toBeVisible();
    const historia = (await page.locator("main").textContent()) ?? "";
    expect(historia, "o token não aparece na execução").not.toContain(TOKEN);
    expect(await page.content()).not.toContain(TOKEN);
    await foto(page, "04-execucao-falhou-destino-recusado");

    expect(recebidas, "o receptor local não pode ter recebido nada").toBe(0);
  });
});
