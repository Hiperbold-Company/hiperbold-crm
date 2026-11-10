/**
 * AUTOMAÇÕES — LOTE 3: gatilhos novos e uma automação iniciando outra,
 * provados pela tela, no cenário de uma loja que atende quem veio do anúncio:
 *
 *   "Rastrear origem"
 *     Início (Iniciada por outra automação, de qualquer uma)
 *       → Definir campo: Origem do negócio = {{param.origem}} → Fim
 *
 *   "Atender anúncio"
 *     Início (Mensagem recebida, contém "saber mais", só pelo número da loja)
 *       → Ações de CRM: Iniciar outra automação "Rastrear origem", origem = anuncio
 *       → Aguardar 1 dia → Fim
 *
 *   "Acompanhar visita"
 *     Início (Tag adicionada no negócio: "visita") → Ações de CRM: tag "acompanhar" → Fim
 *
 * O "Aguardar 1 dia" mantém a execução de "Atender anúncio" viva: é o que torna
 * determinístico o caso da segunda mensagem (reentrada "não iniciar de novo"),
 * que a tela conta como "Gatilho ignorado: o contato já estava nesta automação".
 *
 * O que este arquivo prova, clicando:
 *   1. os formulários dos gatilhos "Mensagem recebida", "Iniciada por outra
 *      automação" e "Tag adicionada" e da ação "Iniciar outra automação";
 *   2. a mensagem "Oi, quero saber mais" entra pelo webhook do WAHA e inicia
 *      "Atender anúncio", que inicia "Rastrear origem" passando origem=anuncio;
 *      o campo do negócio fica "anuncio";
 *   3. a execução de "Rastrear origem" diz quem a iniciou e as CHAVES dos dados
 *      recebidos, nunca o valor;
 *   4. a segunda "saber mais", com a primeira execução viva, é ignorada;
 *   5. "bom dia" não inicia nada;
 *   6. pôr a tag "visita" pela ficha do negócio inicia "Acompanhar visita".
 *
 * Utilitários de canvas espelham `automacoes-botoes-e-pergunta.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote3";
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

/** O dreno do event_log e o worker dos fluxos, chamados como o agendador os chama. */
async function processar(page: Page, vezes = 3): Promise<void> {
  for (let i = 0; i < vezes; i++) {
    const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${SEGREDO}` },
      timeout: 90_000,
    });
    expect(dreno.status(), `dreno ${i + 1}: ${await dreno.text()}`).toBe(200);
    const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
      headers: { authorization: `Bearer ${SEGREDO}` },
      timeout: 90_000,
    });
    expect(tick.ok(), `worker ${i + 1}: ${tick.status()} ${await tick.text()}`).toBe(true);
  }
}

/** Cria a automação pela lista e abre o editor; devolve o id. */
async function novaAutomacao(page: Page, nome: string): Promise<string> {
  await page.goto("/app/automacoes");
  await page.getByTestId("nova-automacao").click();
  await page.getByLabel("Nome", { exact: true }).fill(nome);
  await page.getByTestId("criar-automacao").click();
  await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]+$/, { timeout: PRAZO });
  const id = page.url().split("/").pop()!;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
  // O aviso "Fluxo criado." cobriria o topo das fotos do painel.
  await expect(page.getByText("Fluxo criado.")).toHaveCount(0, { timeout: 20_000 });
  await zoomAte(page, 0.8);
  return id;
}

async function publicar(page: Page): Promise<void> {
  await page.getByTestId("auto-fit-flow").click();
  await page.waitForTimeout(500);
  await page.getByTestId("publish-button").click();
  await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
  await expect(page.locator('[data-testid^="node-error-"]')).toHaveCount(0);
  await expect(page.getByLabel(/status: Ativo/)).toBeVisible({ timeout: PRAZO });
  await expect(page.getByText("Fluxo publicado.")).toHaveCount(0, { timeout: 20_000 });
}

/** Execuções de uma automação para um contato, lidas no banco (só para esperar o motor). */
async function execucoes(orgId: string, pointerId: string, contactId: string) {
  const { data } = await banco
    .from("followup_enrollments")
    .select("id, status")
    .eq("organization_id", orgId)
    .eq("pointer_id", pointerId)
    .eq("contact_id", contactId);
  return (data ?? []) as Array<{ id: string; status: string }>;
}

async function eventos(orgId: string, enrollmentId: string, tipo: string): Promise<number> {
  const { count } = await banco
    .from("followup_enrollment_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("enrollment_id", enrollmentId)
    .eq("event_type", tipo);
  return count ?? 0;
}

test.describe("Automações — gatilhos e uma automação iniciando outra", () => {
  test.setTimeout(8 * 60_000);
  test.use({ actionTimeout: 30_000 });

  test("mensagem com palavra-chave inicia Atender anúncio, que inicia Rastrear origem com dados", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const carimbo = Date.now().toString(36);
    const sessaoId = randomUUID();
    const token = `e2e-gatilhos-${randomUUID()}`;
    const sessaoNome = `loja-${carimbo}`;
    const telefoneAna = `55319${String(Date.now()).slice(-8)}`;
    const nomeRastrear = `Rastrear origem ${carimbo}`;
    const nomeAtender = `Atender anúncio ${carimbo}`;
    const nomeVisita = `Acompanhar visita ${carimbo}`;

    try {
      // ── Preparação: o número de WhatsApp conectado e o campo do negócio. ──
      const sessao = await banco.from("channel_sessions").insert({
        id: sessaoId,
        organization_id: creds.org_id,
        waha_session_name: sessaoNome,
        display_name: "WhatsApp da loja",
        provider: "waha",
        status: "WORKING",
        webhook_secret_encrypted: "\\x00",
        webhook_path_token: token,
      } as never);
      expect(sessao.error, "criar o número de WhatsApp").toBeNull();

      await loginComoAdmin(page, creds);
      const { data: padrao } = await banco
        .from("crm_pipelines")
        .select("id")
        .eq("organization_id", creds.org_id)
        .eq("is_default", true)
        .eq("is_archived", false)
        .maybeSingle();
      const funis = (
        (await (await page.request.get("/api/v1/pipelines")).json()) as {
          data: Array<{ id: string }>;
        }
      ).data;
      const funilDeEntrada = (padrao as { id: string } | null)?.id ?? funis[0]!.id;
      const campo = await page.request.post(`/api/v1/pipelines/${funilDeEntrada}/fields`, {
        data: { key: "origem_do_contato", label: "Origem do contato", type: "text" },
      });
      expect([200, 201, 409], `campo: ${campo.status()} ${await campo.text()}`).toContain(
        campo.status(),
      );

      const inbound = async (texto: string): Promise<void> => {
        const r = await page.request.post(`/api/v1/webhooks/waha/${token}`, {
          data: {
            event: "message",
            session: sessaoNome,
            payload: {
              id: `false_${telefoneAna}@c.us_${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`,
              from: `${telefoneAna}@c.us`,
              fromMe: false,
              body: texto,
              timestamp: Math.floor(Date.now() / 1000),
              _data: { notifyName: "Ana Ribeiro" },
            },
          },
        });
        expect(r.status(), `inbound "${texto}": ${await r.text()}`).toBe(200);
      };

      // ── 1. "Rastrear origem": iniciada por outra automação → Definir campo → Fim ──
      const rastrearId = await novaAutomacao(page, nomeRastrear);
      await abrirNo(page, "n1");
      await page.getByTestId("gatilho-0-tipo").selectOption("started_by_automation");
      await expect(page.getByTestId("gatilho-0-aceitar")).toHaveValue("qualquer");
      await expect(page.getByTestId("automation-trigger-form")).toContainText("{{param.chave}}");
      await foto(
        page,
        "03-gatilho-iniciada-por-outra-automacao",
        page.getByTestId("node-config-panel"),
      );
      await fecharPainel(page);
      await abrirNo(page, "n2");
      await page.getByTestId("delete-node").click();
      const definir = await adicionar(page, "field_op");
      const fimRastrear = await adicionar(page, "end");
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForTimeout(400);
      await abrirNo(page, definir);
      await page.getByTestId("operacao-0-campo").selectOption("lead_custom:origem_do_contato");
      await page.locator("#operacao-0-valor").fill("{{param.origem}}");
      await fecharPainel(page);
      await ligar(page, "n1", definir);
      await ligar(page, definir, fimRastrear, "else");
      await ligar(page, definir, fimRastrear, "erro");
      await publicar(page);

      // ── 2. "Atender anúncio": mensagem contém "saber mais" → Iniciar outra → Aguardar → Fim ──
      const atenderId = await novaAutomacao(page, nomeAtender);
      await abrirNo(page, "n1");
      await page.getByTestId("gatilho-0-tipo").selectOption("message_received");
      await page.getByTestId("gatilho-0-modo").selectOption("contains");
      await page.getByTestId("gatilho-0-palavra").fill("saber mais");
      await page.getByTestId("gatilho-0-palavra").press("Enter");
      await expect(page.getByTestId("gatilho-0-palavra-chip-0")).toContainText("saber mais");
      await page.getByTestId(`gatilho-0-canal-${sessaoId}`).check();
      await expect(page.getByTestId("gatilho-0-sem-atendente")).toBeChecked();
      await expect(page.getByTestId("gatilho-erro")).toHaveCount(0);
      await foto(page, "01-gatilho-mensagem-recebida", page.getByTestId("node-config-panel"));
      await fecharPainel(page);
      await abrirNo(page, "n2");
      await page.getByTestId("delete-node").click();
      const iniciar = await adicionar(page, "crm_action");
      const aguardar = await adicionar(page, "wait");
      const fimAtender = await adicionar(page, "end");
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForTimeout(400);

      await abrirNo(page, iniciar);
      await page.getByTestId("acao-0-tipo").selectOption("start_automation");
      await page.getByTestId("acao-0-automacao").selectOption(rastrearId);
      await page.getByTestId("acao-0-adicionar-dado").click();
      await page.getByTestId("acao-0-dado-0-chave").fill("origem");
      await page.getByTestId("acao-0-dado-0-valor").fill("anuncio");
      await expect(page.getByTestId("acao-0-dado-0-erro")).toHaveCount(0);
      await expect(page.getByTestId("crm-action-form")).toContainText("{{param.chave}}");
      await foto(page, "02-acao-iniciar-outra-automacao", page.getByTestId("node-config-panel"));
      await fecharPainel(page);

      await abrirNo(page, aguardar);
      await page.getByTestId("wait-mode").selectOption("delay");
      await page.getByTestId("wait-delay").fill("1");
      await page.getByTestId("wait-delay-unidade").selectOption("dias");
      await expect(page.getByTestId("wait-erro")).toHaveCount(0);
      await fecharPainel(page);

      await ligar(page, "n1", iniciar);
      await ligar(page, iniciar, aguardar, "else");
      await ligar(page, iniciar, fimAtender, "erro");
      await ligar(page, aguardar, fimAtender);
      await publicar(page);
      // O card diz o NOME da automação iniciada, não "escolhida".
      await expect(page.getByTestId(`node-card-${iniciar}`)).toContainText(nomeRastrear);
      await foto(page, "04-editor-atender-anuncio");

      // ── 3. A mensagem de Ana ──
      await inbound("Oi, quero saber mais");
      const contatoDaAna = async (): Promise<string | null> => {
        const r = await page.request.get(
          `/api/v1/contacts?search=${telefoneAna.slice(-8)}&limit=5`,
        );
        const lista = (
          (await r.json()) as { data: Array<{ id: string; phone_number: string | null }> }
        ).data;
        return (
          lista.find((x) =>
            (x.phone_number ?? "").replace(/\D/g, "").endsWith(telefoneAna.slice(-8)),
          )?.id ?? null
        );
      };
      await expect.poll(contatoDaAna, { timeout: PRAZO }).not.toBeNull();
      const anaId = (await contatoDaAna())!;

      await expect
        .poll(
          async () => {
            await processar(page, 1);
            return (await execucoes(creds.org_id, rastrearId, anaId)).length;
          },
          { timeout: 2 * PRAZO, intervals: [1_000] },
        )
        .toBe(1);
      expect((await execucoes(creds.org_id, atenderId, anaId)).length).toBe(1);

      // O negócio de Ana ganhou o campo com o valor passado.
      const negocioDaAna = async () => {
        const r = await page.request.get(`/api/v1/contacts/${anaId}/crm-summary`);
        return (
          (await r.json()) as {
            data: { leads: Array<{ id: string; custom_fields: Record<string, unknown> | null }> };
          }
        ).data.leads[0];
      };
      await expect
        .poll(
          async () => {
            await processar(page, 1);
            return (await negocioDaAna())?.custom_fields?.origem_do_contato ?? null;
          },
          { timeout: 2 * PRAZO, intervals: [1_000] },
        )
        .toBe("anuncio");
      const leadDaAna = (await negocioDaAna())!.id;

      // Execuções de "Rastrear origem", pela tela.
      await page.goto(`/app/automacoes/${rastrearId}/execucoes`);
      const linhasRastrear = page.getByTestId("lista-de-execucoes").getByRole("link");
      await expect(linhasRastrear).toHaveCount(1, { timeout: PRAZO });
      await expect(linhasRastrear.first()).toContainText("Ana Ribeiro");
      await foto(page, "05-lista-de-execucoes");
      await linhasRastrear.first().click();
      await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
      const timeline = page.getByTestId("dossie-timeline");
      await expect(timeline).toBeVisible({ timeout: PRAZO });
      await expect(timeline.getByText(`Iniciada pela automação “${nomeAtender}”`)).toBeVisible();
      await expect(timeline.getByText("dados recebidos: {{param.origem}}")).toBeVisible();
      await expect(timeline.getByText("outra automação a iniciou")).toBeVisible();
      const historia = (await timeline.textContent()) ?? "";
      expect(historia, "o valor do dado não entra nos eventos").not.toContain("anuncio");
      expect(historia, "o texto do contato não entra nos eventos").not.toContain("saber mais");
      expect(historia.match(UUID_RX), "uuid na história da execução").toBeNull();
      await foto(page, "06-execucao-rastrear-origem");

      // Execução de "Atender anúncio": diz que iniciou a outra.
      const [execAtender] = await execucoes(creds.org_id, atenderId, anaId);
      expect(execAtender!.status, "Atender anúncio segue viva no Aguardar").toMatch(
        /^(active|waiting_reply)$/,
      );
      await page.goto(`/app/ai/followups/enrollments/${execAtender!.id}`);
      const timelineAtender = page.getByTestId("dossie-timeline");
      await expect(timelineAtender.getByText(`Iniciou a automação “${nomeRastrear}”`)).toBeVisible({
        timeout: PRAZO,
      });
      expect((await timelineAtender.textContent()) ?? "").not.toContain("saber mais");

      // A ficha do negócio mostra o campo.
      await page.goto(`/app/leads/${leadDaAna}`);
      const campoNaTela = page.getByRole("textbox", { name: "Origem do contato" });
      await expect(campoNaTela).toHaveValue("anuncio", { timeout: PRAZO });
      await campoNaTela.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(EVIDENCIA, "08-negocio-com-o-campo.png") });

      // ── 4. Segunda "saber mais" com a execução viva: gatilho ignorado. ──
      await inbound("Quero saber mais sobre o produto");
      await expect
        .poll(
          async () => {
            await processar(page, 1);
            return eventos(creds.org_id, execAtender!.id, "trigger_ignored_running");
          },
          { timeout: 2 * PRAZO, intervals: [1_000] },
        )
        .toBe(1);
      expect((await execucoes(creds.org_id, atenderId, anaId)).length).toBe(1);
      expect((await execucoes(creds.org_id, rastrearId, anaId)).length).toBe(1);
      await page.goto(`/app/ai/followups/enrollments/${execAtender!.id}`);
      await expect(
        page
          .getByTestId("dossie-timeline")
          .getByText("Gatilho ignorado: o contato já estava nesta automação"),
      ).toBeVisible({ timeout: PRAZO });
      await foto(page, "07-execucao-atender-anuncio-gatilho-ignorado");

      // ── 5. "bom dia" não casa: nada novo. ──
      await inbound("bom dia");
      await processar(page, 3);
      expect(await eventos(creds.org_id, execAtender!.id, "trigger_ignored_running")).toBe(1);
      expect((await execucoes(creds.org_id, atenderId, anaId)).length).toBe(1);
      expect((await execucoes(creds.org_id, rastrearId, anaId)).length).toBe(1);
      await page.goto(`/app/automacoes/${atenderId}/execucoes`);
      await expect(page.getByTestId("lista-de-execucoes").getByRole("link")).toHaveCount(1, {
        timeout: PRAZO,
      });

      // ── 6. Gatilho "Tag adicionada": "Acompanhar visita" ──
      const visitaId = await novaAutomacao(page, nomeVisita);
      await abrirNo(page, "n1");
      await page.getByTestId("gatilho-0-tipo").selectOption("tag_added");
      await expect(page.getByTestId("gatilho-0-alvo")).toHaveValue("lead");
      await page.getByTestId("gatilho-0-tag").fill("visita");
      await page.getByTestId("gatilho-0-tag").press("Enter");
      await expect(page.getByTestId("gatilho-0-tag-chip-0")).toContainText("visita");
      await foto(page, "09-gatilho-tag-adicionada", page.getByTestId("node-config-panel"));
      await fecharPainel(page);
      await abrirNo(page, "n2");
      await page.getByTestId("delete-node").click();
      const acompanhar = await adicionar(page, "crm_action");
      const fimVisita = await adicionar(page, "end");
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForTimeout(400);
      await abrirNo(page, acompanhar);
      await page.getByTestId("acao-0-tipo").selectOption("add_tags");
      await page.getByTestId("acao-0-alvo").selectOption("lead");
      await page.locator("#acao-0-tags").fill("acompanhar");
      await fecharPainel(page);
      await ligar(page, "n1", acompanhar);
      await ligar(page, acompanhar, fimVisita, "else");
      await ligar(page, acompanhar, fimVisita, "erro");
      await publicar(page);

      // A tag entra pela ficha do negócio, como um atendente faria.
      await page.goto(`/app/leads/${leadDaAna}`);
      const campoDaTag = page.getByRole("textbox", { name: "Adicionar tag ao negócio" });
      await expect(campoDaTag).toBeVisible({ timeout: PRAZO });
      await campoDaTag.fill("visita");
      await campoDaTag.press("Enter");
      await page.getByRole("button", { name: "Salvar", exact: true }).click();
      await expect
        .poll(
          async () => {
            const { data } = await banco
              .from("crm_leads")
              .select("tags")
              .eq("organization_id", creds.org_id)
              .eq("id", leadDaAna)
              .single();
            return ((data as { tags: string[] | null }).tags ?? []).includes("visita");
          },
          { timeout: PRAZO },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            await processar(page, 1);
            const { data } = await banco
              .from("crm_leads")
              .select("tags")
              .eq("organization_id", creds.org_id)
              .eq("id", leadDaAna)
              .single();
            return ((data as { tags: string[] | null }).tags ?? []).includes("acompanhar");
          },
          { timeout: 2 * PRAZO, intervals: [1_000] },
        )
        .toBe(true);
      expect((await execucoes(creds.org_id, visitaId, anaId)).length).toBe(1);
      await page.goto(`/app/automacoes/${visitaId}/execucoes`);
      const linhaVisita = page.getByTestId("lista-de-execucoes").getByRole("link");
      await expect(linhaVisita).toHaveCount(1, { timeout: PRAZO });
      await linhaVisita.first().click();
      await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
      await expect(
        page.getByTestId("dossie-timeline").getByText("começou: tag adicionada"),
      ).toBeVisible({ timeout: PRAZO });
      await foto(page, "10-execucao-tag-adicionada");
    } finally {
      await banco
        .from("channel_sessions")
        .update({ archived_at: new Date().toISOString(), status: "STOPPED" } as never)
        .eq("organization_id", creds.org_id)
        .eq("id", sessaoId);
    }
  });
});
