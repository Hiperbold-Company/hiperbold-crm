/**
 * AUTOMAÇÕES DO CRM (lote 1, migration 0986) — a prova pela tela do cenário
 * "Novo lead do Facebook", como um dono de clínica montaria:
 *
 *   Lead criado (por fonte de captação)
 *     → Condição: campo "Origem" contém "facebook"
 *       → Sim: Definir campo "Mídia" = "Anúncio pago"
 *              → Ações de CRM: tag "Facebook" + criar negócio no funil "Pós-venda"
 *                → Fim
 *       → Não: Fim
 *
 * O que este arquivo prova, clicando:
 *   1. a porta: "Automações" no menu do CRM leva à lista, e "Nova automação"
 *      abre o editor já com Início e Fim;
 *   2. o gatilho, a condição, a operação de campo e as ações são escolhidos
 *      em listas, pelo nome — nenhum identificador digitado;
 *   3. o publish aceita;
 *   4. a consequência: um lead que chega pela captação com "Origem: Facebook
 *      Ads" ganha o campo, a tag e o negócio novo, numa execução que a tela
 *      conta em português; um lead com outra origem passa pela condição e não
 *      ganha nada;
 *   5. o follow-up manual do mesmo contato continua funcionando (raias
 *      separadas: a automação não ocupa a vaga do follow-up).
 *
 * Utilitários de canvas espelham `followup-cartoes.spec.ts` de propósito.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote1";
const PRAZO = 60_000;
const SEGREDO = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";
const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function ligar(page: Page, origem: string, destino: string, ramo?: string): Promise<void> {
  const seletor = ramo
    ? `.react-flow__node[data-id="${origem}"] .react-flow__handle.source[data-handleid="${ramo}"]`
    : `.react-flow__node[data-id="${origem}"] .react-flow__handle.source`;
  const arestas = page.locator(".react-flow__edge");
  const antes = await arestas.count();
  // Medido: um arrasto que começa um pixel fora da bolinha vira CLIQUE no bloco,
  // que abre o painel e encolhe o canvas. Por isso confere a aresta nova e, se
  // ela não veio, fecha o painel e tenta de novo com as caixas relidas.
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

async function fecharPainel(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId("node-config-sheet")).toHaveCount(0, { timeout: PRAZO });
}

async function abrirNo(page: Page, nodeId: string): Promise<void> {
  await page.locator(`[data-testid="node-card-${nodeId}"]`).click();
  await expect(page.getByTestId("node-config-panel")).toBeVisible({ timeout: PRAZO });
}

/** Adiciona um bloco pela paleta e devolve o id dele (o único novo daquele tipo). */
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

async function drenarTudo(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${SEGREDO}` },
    });
    expect(dreno.status(), `dreno ${i + 1}`).toBe(200);
    const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
      headers: { authorization: `Bearer ${SEGREDO}` },
    });
    expect(tick.ok(), `tick ${i + 1}: ${tick.status()} ${await tick.text()}`).toBe(true);
  }
}

interface LeadDoResumo {
  id: string;
  pipeline_id: string;
  custom_fields: Record<string, unknown> | null;
}

async function negociosDoContato(page: Page, contactId: string): Promise<LeadDoResumo[]> {
  const r = await page.request.get(`/api/v1/contacts/${contactId}/crm-summary`);
  expect(r.ok(), `resumo do contato: ${r.status()}`).toBe(true);
  return ((await r.json()) as { data: { leads: LeadDoResumo[] } }).data.leads;
}

/**
 * As tags do negócio, lidas no banco local (não há rota de leitura de UM
 * negócio com tags). Só leitura, e filtrada pela organização do seed.
 */
const envLocal = carregarEnvLocal();
const banco = createClient(envLocal.NEXT_PUBLIC_SUPABASE_URL ?? "", envLocal.SUPABASE_SERVICE_ROLE_KEY ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function tagsDoNegocio(leadId: string): Promise<string[]> {
  const orgId = (creds as CredsE2E & { org_id?: string }).org_id ?? "";
  const { data, error } = await banco
    .from("crm_leads")
    .select("tags")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  expect(error, "ler as tags do negócio").toBeNull();
  return ((data as { tags?: string[] } | null)?.tags ?? []) as string[];
}

test.describe("Automações do CRM — cenário Novo lead do Facebook", () => {
  test.setTimeout(6 * 60_000);

  test("monta pela tela, publica, e o lead que chega ganha campo, tag e negócio", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const carimbo = Date.now().toString(36);
    // Admin com segundo fator (o seed o liga): o helper passa pelo /login/mfa.
    await loginComoAdmin(page, creds);

    // ── Preparação pela API pública (o que um funil configurado já teria) ──
    const funis = ((await (await page.request.get("/api/v1/pipelines")).json()) as {
      data: Array<{ id: string; name: string; stages?: Array<{ id: string }> }>;
    }).data;
    const funil = funis[0]!;
    for (const campo of [
      { key: "origem", label: "Origem", type: "text" },
      { key: "midia", label: "Mídia", type: "text" },
    ]) {
      const r = await page.request.post(`/api/v1/pipelines/${funil.id}/fields`, { data: campo });
      expect([200, 201, 409], `campo ${campo.key}: ${r.status()} ${await r.text()}`).toContain(r.status());
    }
    const nomeDoPosVenda = `Pós-venda ${carimbo}`;
    const posVenda = await page.request.post("/api/v1/pipelines", { data: { name: nomeDoPosVenda } });
    expect(posVenda.ok(), `criar funil: ${posVenda.status()} ${await posVenda.text()}`).toBe(true);
    // A criação devolve a lista de funis da tela; o id se acha pelo nome na listagem.
    const depois = ((await (await page.request.get("/api/v1/pipelines")).json()) as {
      data: Array<{ id: string; name: string }>;
    }).data;
    const posVendaId = depois.find((f) => f.name === nomeDoPosVenda)!.id;
    expect(posVendaId).toMatch(UUID_RX);
    // As etapas iniciais do funil novo ("Novo", "Em andamento", "Ganho",
    // "Perdido") são chaves do dicionário. O banco do e2e é compartilhado, e o
    // negócio que este teste cria no Pós-venda aparece em /app/metrics, onde
    // `i18n-espanhol-na-tela.spec.ts` leria o nome da etapa (dado) como texto
    // de interface sem tradução. Nome com o carimbo não colide com chave.
    const etapasDoPosVenda = ((await (await page.request.get(`/api/v1/pipelines/${posVendaId}/stages`)).json()) as {
      data: Array<{ id: string; name: string }>;
    }).data;
    expect(etapasDoPosVenda.length).toBeGreaterThan(0);
    for (const etapa of etapasDoPosVenda) {
      const r = await page.request.patch(`/api/v1/pipelines/${posVendaId}/stages/${etapa.id}`, {
        data: { name: `${etapa.name} ${carimbo}` },
      });
      expect(r.ok(), `renomear etapa ${etapa.name}: ${r.status()} ${await r.text()}`).toBe(true);
    }
    const etapasDoFunil = await page.request.get(`/api/v1/pipelines/${funil.id}/stages`);
    const etapaInicial = ((await etapasDoFunil.json()) as { data: Array<{ id: string }> }).data[0]!.id;

    // ── 1. A porta: menu do CRM → lista → Nova automação → editor ──
    await page.goto("/app/inicio");
    await page.getByRole("link", { name: "Automações", exact: true }).first().click();
    await page.waitForURL(/\/app\/automacoes$/, { timeout: PRAZO });
    await foto(page, "01-lista-vazia-ou-com-automacoes");
    await page.getByTestId("nova-automacao").click();
    await page.getByLabel("Nome", { exact: true }).fill(`Novo lead do Facebook ${carimbo}`);
    await page.getByTestId("criar-automacao").click();
    await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]+$/, { timeout: PRAZO });
    const automacaoId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
    await expect(page.getByTestId("palette-grupo-crm")).toBeVisible();
    await zoomAte(page, 0.8);

    // ── 2. Gatilho: Lead criado, por qualquer fonte de captação ──
    await abrirNo(page, "n1");
    await page.getByTestId("gatilho-0-tipo").selectOption("lead_created");
    await page.getByTestId("gatilho-0-fonte").selectOption("__captacao");
    await foto(page, "02-gatilho-lead-criado");
    await fecharPainel(page);

    // O Fim que veio com a automação nova sai (leva a ligação manual junto).
    await abrirNo(page, "n2");
    await page.getByTestId("delete-node").click();

    const condicao = await adicionar(page, "condition");
    const campo = await adicionar(page, "field_op");
    const acoes = await adicionar(page, "crm_action");
    const fim = await adicionar(page, "end");
    // Enquadra os blocos novos (a paleta os põe em grade, alguns fora da vista).
    // Arrastar perto da borda faz o canvas rolar sozinho, então não se arrasta.
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(400);

    // ── Condição: Origem contém facebook ──
    await abrirNo(page, condicao);
    await page.getByTestId("regra-0-campo").selectOption("lead_custom:origem");
    await page.getByTestId("regra-0-op").selectOption("contains");
    await page.locator("#regra-0-valor").fill("facebook");
    await expect(page.getByTestId("condicao-automacao-form")).toContainText("“facebook”");
    await foto(page, "03-condicao-origem-contem-facebook");
    await fecharPainel(page);

    // ── Definir campo: Mídia = Anúncio pago ──
    await abrirNo(page, campo);
    await page.getByTestId("operacao-0-campo").selectOption("lead_custom:midia");
    await page.locator("#operacao-0-valor").fill("Anúncio pago");
    await foto(page, "04-definir-campo-midia");
    await fecharPainel(page);

    // ── Ações de CRM: tag Facebook + criar negócio no Pós-venda ──
    await abrirNo(page, acoes);
    await page.getByTestId("acao-0-tipo").selectOption("add_tags");
    await page.getByTestId("acao-0-alvo").selectOption("lead");
    await page.locator("#acao-0-tags").fill("Facebook");
    await page.getByTestId("adicionar-acao").click();
    await page.getByTestId("acao-1-tipo").selectOption("create_deal");
    await page.getByTestId("acao-1-funil").selectOption(posVendaId);
    await expect(page.getByTestId("acao-1-etapa")).not.toHaveValue("");
    await expect(page.getByTestId("crm-action-form")).toContainText(nomeDoPosVenda);
    await foto(page, "05-acoes-de-crm");
    await fecharPainel(page);

    // ── Ligações ──
    await ligar(page, "n1", condicao);
    await ligar(page, condicao, campo, "true");
    await ligar(page, condicao, fim, "false");
    await ligar(page, campo, acoes, "else");
    await ligar(page, campo, fim, "erro");
    await ligar(page, acoes, fim, "else");
    await ligar(page, acoes, fim, "erro");

    await page.getByTestId("auto-fit-flow").click();
    await page.waitForTimeout(500);

    // ── 3. Publicar ──
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
    await expect(page.locator('[data-testid^="node-error-"]')).toHaveCount(0);
    await expect(page.getByLabel(/status: Ativo/)).toBeVisible({ timeout: PRAZO });
    await expect(page.getByTestId("testar-automacao")).toBeEnabled();
    await foto(page, "06-automacao-publicada");

    // ── 4. Um lead chega pela captação, com Origem: Facebook Ads ──
    const fonte = await page.request.post("/api/v1/webhook-sources", {
      data: { name: `Formulário ${carimbo}`, default_pipeline_id: funil.id, default_stage_id: etapaInicial },
    });
    expect(fonte.ok(), `criar fonte: ${fonte.status()} ${await fonte.text()}`).toBe(true);
    const token = ((await fonte.json()) as { data: { path_token: string } }).data.path_token;
    const enviar = async (nome: string, origem: string) => {
      const r = await page.request.post(`/api/v1/webhooks/in/${token}`, {
        data: { nome, telefone: `+55119${String(Date.now()).slice(-8)}`, origem },
      });
      expect(r.status(), `captação de ${nome}: ${await r.text()}`).toBe(200);
      await page.waitForTimeout(50);
    };
    const nomeDoFacebook = `Ana Facebook ${carimbo}`;
    const nomeDoGoogle = `Bruno Google ${carimbo}`;
    await enviar(nomeDoFacebook, "Facebook Ads");
    await enviar(nomeDoGoogle, "Google");
    await drenarTudo(page);

    const contatoDe = async (nome: string): Promise<string> => {
      const r = await page.request.get(`/api/v1/contacts?search=${encodeURIComponent(nome)}&limit=5`);
      const lista = ((await r.json()) as { data: Array<{ id: string; name: string }> }).data;
      const c = lista.find((x) => x.name === nome);
      expect(c, `contato ${nome}`).toBeTruthy();
      return c!.id;
    };
    const anaId = await contatoDe(nomeDoFacebook);
    const brunoId = await contatoDe(nomeDoGoogle);

    // Ana: campo, tag e o negócio novo no Pós-venda.
    const negociosDaAna = await negociosDoContato(page, anaId);
    const original = negociosDaAna.find((n) => n.pipeline_id === funil.id);
    expect(original, "o negócio da captação").toBeTruthy();
    expect(original!.custom_fields?.midia).toBe("Anúncio pago");
    expect(await tagsDoNegocio(original!.id)).toContain("Facebook");
    expect(negociosDaAna.some((n) => n.pipeline_id === posVendaId), "negócio criado no Pós-venda").toBe(true);

    // Bruno: passou pela condição e não ganhou nada.
    const negociosDoBruno = await negociosDoContato(page, brunoId);
    expect(negociosDoBruno.some((n) => n.pipeline_id === posVendaId)).toBe(false);
    expect(negociosDoBruno[0]!.custom_fields?.midia).toBeUndefined();

    // A tela das execuções conta, em português, o que aconteceu.
    await page.goto(`/app/automacoes/${automacaoId}/execucoes`);
    const linhaDaAna = page.getByTestId("lista-de-execucoes").getByRole("link", { name: new RegExp(nomeDoFacebook) });
    await expect(linhaDaAna).toBeVisible({ timeout: PRAZO });
    await foto(page, "07-execucoes");
    await linhaDaAna.click();
    await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
    await expect(page.getByText(/Ações de CRM|Definir campo/).first()).toBeVisible({ timeout: PRAZO });
    // Nenhum identificador cru na história da execução.
    const historia = (await page.locator("main").textContent()) ?? "";
    expect(historia.match(UUID_RX), "uuid na tela da execução").toBeNull();
    await foto(page, "08-execucao-em-portugues");

    // O negócio na tela: o funil Pós-venda tem o card da Ana.
    await page.goto(`/app/pipelines/${posVendaId}`);
    await expect(page.getByText(nomeDoFacebook).first()).toBeVisible({ timeout: PRAZO });
    await foto(page, "09-negocio-criado-no-pos-venda");

    // ── 5. O follow-up do mesmo contato continua funcionando ──
    // Um follow-up manual mínimo (Início → espera → Fim), publicado pela API.
    const criado = await page.request.post("/api/v1/ai/followup-flows", { data: { name: `Lembrete ${carimbo}` } });
    expect(criado.ok(), `criar follow-up: ${criado.status()}`).toBe(true);
    const followupId = ((await criado.json()) as { data: { id: string } }).data.id;
    const grafo = {
      nodes: [
        { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        { id: "w", type: "wait", label: "Esperar", position: { x: 0, y: 100 }, config: { mode: "fixed", duration_ms: 3_600_000 } },
        { id: "f", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "a", source: "t", target: "w", priority: 0, condition: { type: "always" } },
        { id: "b", source: "w", target: "f", priority: 0, condition: { type: "always" } },
      ],
    };
    const salvo = await page.request.patch(`/api/v1/ai/followup-flows/${followupId}`, { data: { draft_graph: grafo } });
    expect(salvo.ok(), `salvar follow-up: ${salvo.status()} ${await salvo.text()}`).toBe(true);
    const publicado = await page.request.post(`/api/v1/ai/followup-flows/${followupId}/publish`, { data: {} });
    expect(publicado.ok(), `publicar follow-up: ${publicado.status()} ${await publicado.text()}`).toBe(true);
    const matricula = await page.request.post("/api/v1/ai/followups/enrollments", {
      data: { pointer_id: followupId, contact_id: anaId },
    });
    expect(matricula.ok(), `follow-up da Ana: ${matricula.status()} ${await matricula.text()}`).toBe(true);
    await drenarTudo(page);
    const idDaMatricula = ((await matricula.json()) as { data: { id: string } }).data.id;
    const fila = await page.request.get("/api/v1/ai/followups/enrollments");
    const doFollowup = ((await fila.json()) as { data: Array<{ id: string; status: string }> }).data.find(
      (m) => m.id === idDaMatricula,
    );
    expect(doFollowup?.status ?? "", "o follow-up da Ana segue vivo ao lado da automação").toMatch(/^(active|waiting_reply)$/);
  });
});
