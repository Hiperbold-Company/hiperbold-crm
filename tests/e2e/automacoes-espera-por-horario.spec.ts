/**
 * AUTOMAÇÕES — LOTE 6: esperas por horário, provadas pela tela.
 *
 *   Início (Manual)
 *     → Esperar até amanhã, 09:00 (fuso da organização)
 *       → Condição "Está no horário?" (todos os dias, 00:00–23:59)
 *         → Sim: Ações de CRM: tag "no-horario" no contato → Fim
 *         → Não: Fim
 *
 * O que este arquivo prova, clicando:
 *   1. o bloco Esperar oferece "Esperar até um dia e horário", com "Amanhã" e a
 *      hora, e o card diz "Até amanhã, 09:00";
 *   2. a condição oferece "Está no horário?", com início, fim e dias;
 *   3. o publish aceita, e "Testar com um contato" inicia a execução;
 *   4. a execução estaciona até AMANHÃ às 09:00 no relógio da organização
 *      (lido do banco e conferido no fuso dela), e a tela de execuções diz
 *      "Esperando até …";
 *   5. a retomada: o produto não tem relógio controlável, então o teste faz o
 *      tempo passar do único jeito honesto — põe o `next_eval_at` DESTA
 *      execução (filtrada pela organização do seed) no passado, como se fosse
 *      amanhã 09:00 — e chama o relógio do jeito que o agendador chama. A
 *      execução segue pela condição (está no horário) e o contato ganha a tag.
 *
 * Utilitários de canvas espelham `automacoes-botoes-e-pergunta.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote6";
const PRAZO = 60_000;
const SEGREDO = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";
const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function loadCreds(): CredsE2E & { org_id: string } {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsE2E & { org_id: string };
}

const creds = loadCreds();
const { url, serviceRole } = credenciaisSupabaseDeTeste();
const banco = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function foto(page: Page, nome: string, alvo?: ReturnType<Page["locator"]>): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  const arquivo = path.join(EVIDENCIA, `${nome}.png`);
  if (alvo) {
    await alvo.screenshot({ path: arquivo });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("main, main *"))) {
        if (el.scrollTop > 0 && !el.closest('[data-testid="node-config-panel"]')) el.scrollTop = 0;
      }
    });
  } else await page.screenshot({ path: arquivo, fullPage: true });
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
    const tBox = await page
      .locator(`.react-flow__node[data-id="${destino}"] .react-flow__handle.target`)
      .boundingBox();
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
    await page
      .locator(`.react-flow__node[data-id^="${tipo}-"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
  );
  await page.getByTestId(`palette-add-${tipo}`).click();
  await expect
    .poll(
      async () =>
        (await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).count()) > antes.size,
    )
    .toBe(true);
  const depois = await page
    .locator(`.react-flow__node[data-id^="${tipo}-"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  return depois.find((id) => !antes.has(id))!;
}

/** O relógio de 1/min, chamado como o agendador o chama. */
async function relogio(page: Page, vezes = 2): Promise<void> {
  for (let i = 0; i < vezes; i++) {
    const r = await page.request.post("/api/v1/system/relogio/tick", {
      headers: { authorization: `Bearer ${SEGREDO}` },
      timeout: 90_000,
    });
    expect(r.ok(), `relógio ${i + 1}: ${r.status()} ${await r.text()}`).toBe(true);
  }
}

/** Dia (AAAA-MM-DD) e hora (HH:MM) de um instante no fuso pedido. */
function paredeNoFuso(instante: Date, fuso: string): { dia: string; hora: string } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { dia: `${v("year")}-${v("month")}-${v("day")}`, hora: `${v("hour")}:${v("minute")}` };
}

function diaSeguinte(dia: string): string {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

test.describe("Automações — esperar até amanhã 9h e 'Está no horário?'", () => {
  test.setTimeout(6 * 60_000);
  test.use({ actionTimeout: 30_000 });

  test("monta pela tela, estaciona até amanhã 09:00 no fuso da organização e retoma pela condição", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const carimbo = Date.now().toString(36);
    const nomeDoContato = `Carla Horario ${carimbo}`;

    await loginComoAdmin(page, creds);
    const criado = await page.request.post("/api/v1/contacts", {
      data: { name: nomeDoContato, source: "manual" },
    });
    expect(criado.status(), `criar o contato: ${await criado.text()}`).toBe(201);
    const contatoId = ((await criado.json()) as { data: { id: string } }).data.id;

    const { data: org } = await banco
      .from("organizations")
      .select("timezone")
      .eq("id", creds.org_id)
      .single();
    const fuso =
      ((org as { timezone?: string | null } | null)?.timezone ?? "").trim() || "America/Sao_Paulo";

    // ── 1. Lista → Nova automação → editor ──
    await page.goto("/app/automacoes");
    await page.getByTestId("nova-automacao").click();
    await page.getByLabel("Nome", { exact: true }).fill(`Lembrete amanhã 9h ${carimbo}`);
    await page.getByTestId("criar-automacao").click();
    await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]+$/, { timeout: PRAZO });
    const automacaoId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
    await zoomAte(page, 0.8);

    await abrirNo(page, "n1");
    await expect(page.getByTestId("gatilho-0-tipo")).toHaveValue("manual");
    await fecharPainel(page);
    await abrirNo(page, "n2");
    await page.getByTestId("delete-node").click();

    const espera = await adicionar(page, "wait");
    const condicao = await adicionar(page, "condition");
    const tag = await adicionar(page, "crm_action");
    const fim = await adicionar(page, "end");
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(400);

    // ── 2. Esperar até amanhã, 09:00 ──
    await abrirNo(page, espera);
    await page.getByTestId("wait-mode").selectOption("until_time");
    await page.getByTestId("wait-quando").selectOption("tomorrow");
    await page.locator("#wait-hora").fill("09:00");
    await expect(page.getByTestId("wait-erro")).toHaveCount(0);
    await foto(page, "01-espera-ate-amanha-9h", page.getByTestId("node-config-panel"));
    await fecharPainel(page);
    await expect(page.getByTestId(`node-card-${espera}`)).toContainText("Até amanhã, 09:00");

    // ── 3. Condição: Está no horário? (todos os dias, 00:00–23:59) ──
    await abrirNo(page, condicao);
    await page.getByTestId("regra-0-tipo").selectOption("business_hours");
    await page.locator("#regra-0-inicio").fill("00:00");
    await page.locator("#regra-0-fim").fill("23:59");
    const dias = page.getByTestId("regra-0-dias");
    for (const rotulo of ["Dom", "Sáb"]) {
      const botao = dias.getByRole("button", { name: rotulo, exact: true });
      if ((await botao.getAttribute("aria-pressed")) !== "true") await botao.click();
    }
    await expect(dias.locator('button[aria-pressed="true"]')).toHaveCount(7);
    await expect(page.getByTestId("condicao-automacao-form")).toContainText(
      "Agora está entre 00:00 e 23:59",
    );
    await foto(page, "02-condicao-esta-no-horario", page.getByTestId("node-config-panel"));
    await fecharPainel(page);

    // ── Ações de CRM: tag no contato ──
    await abrirNo(page, tag);
    await page.getByTestId("acao-0-tipo").selectOption("add_tags");
    await page.getByTestId("acao-0-alvo").selectOption("contact");
    await page.locator("#acao-0-tags").fill("no-horario");
    await fecharPainel(page);

    // ── Ligações ── (enquadra o fluxo inteiro: com os cartões já preenchidos, o último sai da tela)
    await page.getByTestId("auto-fit-flow").click();
    await page.locator(".react-flow__controls-fitview").click();
    await zoomAte(page, 0.7);
    await page.waitForTimeout(400);
    await ligar(page, "n1", espera);
    await ligar(page, espera, condicao);
    await ligar(page, condicao, tag, "true");
    await ligar(page, condicao, fim, "false");
    await ligar(page, tag, fim, "else");
    await ligar(page, tag, fim, "erro");
    await page.getByTestId("auto-fit-flow").click();
    await page.waitForTimeout(500);
    await foto(page, "03-editor-com-o-fluxo-montado");

    // ── 4. Publicar e iniciar pela tela ──
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
    await expect(page.locator('[data-testid^="node-error-"]')).toHaveCount(0);
    await expect(page.getByTestId("testar-automacao")).toBeEnabled({ timeout: PRAZO });
    await page.getByTestId("testar-automacao").click();
    await page.getByTestId("testar-busca").fill(nomeDoContato);
    const linha = page
      .getByTestId("testar-resultados")
      .locator("li")
      .filter({ hasText: nomeDoContato });
    await expect(linha).toHaveCount(1, { timeout: PRAZO });
    await linha.getByRole("button", { name: "Iniciar" }).click();
    await expect(page.getByTestId("testar-busca")).toHaveCount(0, { timeout: PRAZO });
    await relogio(page);

    // A execução estacionou até amanhã, 09:00, no relógio da organização.
    let ultimoErro = "";
    const execucao = async () => {
      const r = await banco
        .from("followup_enrollments")
        .select("id, status, current_node_id, next_eval_at")
        .eq("organization_id", creds.org_id)
        .eq("pointer_id", automacaoId)
        .eq("contact_id", contatoId)
        .single();
      ultimoErro = `${automacaoId}/${contatoId}/${creds.org_id}: ${JSON.stringify(r.error)}`;
      return r.data as {
        id: string;
        status: string;
        current_node_id: string;
        next_eval_at: string;
      } | null;
    };
    // A matrícula nasce no tick do relógio, não no clique: a linha pode ainda não existir.
    await expect
      .poll(async () => (await execucao())?.current_node_id ?? ultimoErro, { timeout: PRAZO })
      .toBe(espera);
    const estacionada = await execucao();
    const quando = paredeNoFuso(new Date(estacionada.next_eval_at), fuso);
    expect(quando.hora, `volta às 09:00 em ${fuso}`).toBe("09:00");
    expect(quando.dia, "volta AMANHÃ, no dia da organização").toBe(
      diaSeguinte(paredeNoFuso(new Date(), fuso).dia),
    );

    // A tela das execuções conta a espera em português.
    await page.goto(`/app/automacoes/${automacaoId}/execucoes`);
    const linhaDaCarla = page
      .getByTestId("lista-de-execucoes")
      .getByRole("link", { name: new RegExp(nomeDoContato) });
    await expect(linhaDaCarla).toBeVisible({ timeout: PRAZO });
    await linhaDaCarla.click();
    await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
    const timeline = page.getByTestId("dossie-timeline");
    await expect(timeline.getByText(/^Esperando até /).first()).toBeVisible({ timeout: PRAZO });
    expect(((await timeline.textContent()) ?? "").match(UUID_RX), "uuid na história").toBeNull();
    await foto(page, "04-execucao-esperando-ate-amanha");

    // ── 5. A retomada: amanhã às 09:00 chegou para esta execução ──
    const avancou = await banco
      .from("followup_enrollments")
      .update({ next_eval_at: new Date(Date.now() - 1000).toISOString() } as never)
      .eq("organization_id", creds.org_id)
      .eq("id", estacionada.id);
    expect(avancou.error, "fazer o tempo passar").toBeNull();
    await relogio(page);

    await expect
      .poll(async () => (await execucao())?.status ?? "active", { timeout: PRAZO })
      .not.toMatch(/^(active|waiting_reply)$/);
    const { data: contato } = await banco
      .from("contacts")
      .select("tags")
      .eq("organization_id", creds.org_id)
      .eq("id", contatoId)
      .single();
    expect(((contato as { tags?: string[] | null } | null)?.tags ?? []) as string[]).toContain(
      "no-horario",
    );

    await page.reload();
    await expect(timeline.getByText(/Ações de CRM|foi para/).first()).toBeVisible({
      timeout: PRAZO,
    });
    await foto(page, "05-execucao-retomada-pela-condicao");
  });
});
