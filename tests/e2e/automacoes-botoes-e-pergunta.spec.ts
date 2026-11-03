/**
 * AUTOMAÇÕES — LOTE 2: blocos de conversa provados pela tela, no cenário
 * "Qualificar contato" de uma imobiliária:
 *
 *   Início (Manual)
 *     → Pergunta "Qual é o seu nome?" (salva no campo "Nome informado", texto)
 *       → Respondeu: Mensagem "Qual o propósito do imóvel?" com os botões
 *                    "Moradia" e "Investimento"
 *           → Moradia:      Ações de CRM: tag "moradia"      → Fim
 *           → Investimento: Ações de CRM: tag "investimento" → Fim
 *           → Sem resposta / Resposta inválida / Erro         → Fim
 *       → Sem resposta / Resposta inválida / Erro              → Fim
 *
 * O que este arquivo prova, clicando:
 *   1. os blocos Pergunta e Mensagem saem da paleta, os formulários aceitam
 *      texto, campo, validação, botões e tempo de espera, e cada botão vira um
 *      caminho próprio no card;
 *   2. o publish aceita e o "Testar com um contato" inicia a execução;
 *   3. o canal do e2e é WAHA (não oficial): a mensagem sai como TEXTO
 *      NUMERADO ("1) Moradia" / "2) Investimento"), medido no receptor HTTP que
 *      faz o papel do WAHA e na conversa do Inbox;
 *   4. a resposta do contato entra pelo webhook do WAHA (caminho de produção) e
 *      o relógio de 1/min a processa: o nome vai para o campo do negócio, o "2"
 *      escolhe "Investimento" e o negócio ganha a tag;
 *   5. a tela de Execuções conta os passos em português, e nenhum evento guarda
 *      o texto que o contato escreveu;
 *   6. um segundo contato que não escolhe nada segue por "Sem resposta" depois
 *      do tempo mínimo (1 minuto), contado pelo relógio real.
 *
 * Utilitários de canvas espelham `automacoes-crm-basico.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const EVIDENCIA = "evidence/automacoes-lote2";
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
const banco = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

async function foto(page: Page, nome: string, alvo?: ReturnType<Page["locator"]>): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  const arquivo = path.join(EVIDENCIA, `${nome}.png`);
  if (alvo) {
    await alvo.screenshot({ path: arquivo });
    // A foto do painel rola a página para mostrá-lo; o cabeçalho fixo então
    // cobre o topo do canvas e o clique seguinte cai nele. Volta ao topo.
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

/**
 * O papel do WAHA: recebe o `sendText` do produto e devolve um id. É aqui que
 * se mede o que de fato saiu pelo canal (o texto numerado), e não o que a
 * tela acha que saiu.
 */
interface EnvioRecebido {
  chatId: string;
  text: string;
}
async function subirReceptor(envios: EnvioRecebido[]): Promise<Server> {
  const alvo = new URL(process.env.WAHA_API_BASE_URL ?? "");
  expect(["127.0.0.1", "localhost"]).toContain(alvo.hostname);
  const servidor = createServer((req, res) => {
    let corpo = "";
    req.on("data", (p: Buffer) => (corpo += p.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST" && req.url === "/api/sendText") {
        const b = JSON.parse(corpo || "{}") as { chatId?: string; text?: string };
        envios.push({ chatId: b.chatId ?? "", text: b.text ?? "" });
        res.end(JSON.stringify({ id: `true_${b.chatId}_${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}` }));
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(Number(alvo.port), alvo.hostname, resolve);
  });
  return servidor;
}

test.describe("Automações — Qualificar contato (pergunta e botões)", () => {
  test.setTimeout(8 * 60_000);
  // Um clique que não acha o alvo falha em 30 s, não no teto de 8 min do teste.
  test.use({ actionTimeout: 30_000 });

  test("monta pela tela, pergunta o nome, oferece os botões e segue o caminho escolhido", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const carimbo = Date.now().toString(36);
    const envios: EnvioRecebido[] = [];
    const receptor = await subirReceptor(envios);
    const sessaoId = randomUUID();
    const token = `e2e-qualificar-${randomUUID()}`;
    const sufixo = String(Date.now()).slice(-8);
    const sufixoDoJoao = String((Number(sufixo) + 1) % 100_000_000).padStart(8, "0");
    const telefoneMaria = `55119${sufixo}`;
    const telefoneJoao = `55219${sufixoDoJoao}`;

    try {
      // ── Preparação: o número de WhatsApp conectado (como a Central de
      // Conexões deixa um WAHA pareado) e o campo do negócio. ──
      const sessao = await banco.from("channel_sessions").insert({
        id: sessaoId,
        organization_id: creds.org_id,
        waha_session_name: `qualificar-${carimbo}`,
        display_name: "Atendimento Imobiliária",
        provider: "waha",
        status: "WORKING",
        webhook_secret_encrypted: "\\x00",
        webhook_path_token: token,
      } as never);
      expect(sessao.error, "criar o número de WhatsApp").toBeNull();

      await loginComoAdmin(page, creds);
      const funis = ((await (await page.request.get("/api/v1/pipelines")).json()) as {
        data: Array<{ id: string; name: string; is_default?: boolean }>;
      }).data;
      const { data: padrao } = await banco
        .from("crm_pipelines")
        .select("id")
        .eq("organization_id", creds.org_id)
        .eq("is_default", true)
        .eq("is_archived", false)
        .maybeSingle();
      const funilDeEntrada = (padrao as { id: string } | null)?.id ?? funis[0]!.id;
      const campo = await page.request.post(`/api/v1/pipelines/${funilDeEntrada}/fields`, {
        data: { key: "nome_informado", label: "Nome informado", type: "text" },
      });
      expect([200, 201, 409], `campo Nome informado: ${campo.status()} ${await campo.text()}`).toContain(campo.status());

      // ── Os contatos escrevem primeiro (é o que abre a conversa). ──
      const inbound = async (telefone: string, nome: string, texto: string): Promise<void> => {
        const r = await page.request.post(`/api/v1/webhooks/waha/${token}`, {
          data: {
            event: "message",
            session: `qualificar-${carimbo}`,
            payload: {
              id: `false_${telefone}@c.us_${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`,
              from: `${telefone}@c.us`,
              fromMe: false,
              body: texto,
              timestamp: Math.floor(Date.now() / 1000),
              _data: { notifyName: nome },
            },
          },
        });
        expect(r.status(), `inbound de ${nome}: ${await r.text()}`).toBe(200);
      };
      await inbound(telefoneMaria, "Maria", "Oi, vi o anúncio do apartamento no Centro.");
      await inbound(telefoneJoao, "João", "Boa tarde, o apartamento ainda está disponível?");

      // ── 1. Lista → Nova automação → editor ──
      await page.goto("/app/automacoes");
      await page.getByTestId("nova-automacao").click();
      await page.getByLabel("Nome").fill(`Qualificar contato ${carimbo}`);
      await page.getByTestId("criar-automacao").click();
      await page.waitForURL(/\/app\/automacoes\/[0-9a-f-]+$/, { timeout: PRAZO });
      const automacaoId = page.url().split("/").pop()!;
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
      await zoomAte(page, 0.8);

      // O gatilho padrão de automação nova é o Manual.
      await abrirNo(page, "n1");
      await expect(page.getByTestId("gatilho-0-tipo")).toHaveValue("manual");
      await fecharPainel(page);
      await abrirNo(page, "n2");
      await page.getByTestId("delete-node").click();

      const pergunta = await adicionar(page, "question");
      const mensagem = await adicionar(page, "message");
      const tagMoradia = await adicionar(page, "crm_action");
      const tagInvestimento = await adicionar(page, "crm_action");
      const fim = await adicionar(page, "end");
      // "Sem resposta" da mensagem vai a um Fim próprio, com nome: é ele que a
      // história da execução cita ("foi para Sem resposta do contato").
      const fimSemResposta = await adicionar(page, "end");
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForTimeout(400);

      await abrirNo(page, fimSemResposta);
      await page.locator("#node-label").fill("Sem resposta do contato");
      await fecharPainel(page);

      // ── 2. Pergunta ──
      await abrirNo(page, pergunta);
      await page.getByTestId("pergunta-texto").fill("Qual é o seu nome?");
      await page.getByTestId("pergunta-salvar-em").selectOption("lead_custom:nome_informado");
      await expect(page.getByTestId("pergunta-validacao")).toHaveValue("text");
      await expect(page.getByTestId("pergunta-variavel-nome")).toContainText("resposta.");
      await expect(page.getByTestId("pergunta-erro")).toHaveCount(0);
      await foto(page, "02-formulario-da-pergunta", page.getByTestId("node-config-panel"));
      await fecharPainel(page);

      // ── 3. Mensagem com botões ──
      await abrirNo(page, mensagem);
      await page.getByTestId("mensagem-texto").fill("Qual o propósito do imóvel?");
      await page.getByTestId("mensagem-tipo-buttons").click();
      await expect(page.getByTestId("mensagem-tipo-buttons")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("opcao-0-rotulo").fill("Moradia");
      await page.getByTestId("opcao-1-rotulo").fill("Investimento");
      await page.getByTestId("mensagem-espera").fill("1");
      await page.getByTestId("mensagem-espera-unidade").selectOption("minutos");
      await expect(page.getByTestId("mensagem-aviso-canal")).toContainText("numeradas");
      await expect(page.getByTestId("mensagem-erro")).toHaveCount(0);
      const idMoradia = (await page.getByTestId("opcao-0").getAttribute("data-opcao-id"))!;
      const idInvestimento = (await page.getByTestId("opcao-1").getAttribute("data-opcao-id"))!;
      expect(idMoradia).toMatch(/^opcao_/);
      await foto(page, "03-formulario-da-mensagem-com-botoes", page.getByTestId("node-config-panel"));
      await fecharPainel(page);
      // Cada botão vira um caminho no card.
      await expect(page.getByTestId(`node-branch-${mensagem}-${idMoradia}`)).toContainText("Moradia");
      await expect(page.getByTestId(`node-branch-${mensagem}-${idInvestimento}`)).toContainText("Investimento");
      await expect(page.getByTestId(`node-branch-${mensagem}-no_reply`)).toBeVisible();

      // ── Ações de CRM: uma tag por caminho ──
      for (const [no, tag] of [
        [tagMoradia, "moradia"],
        [tagInvestimento, "investimento"],
      ] as const) {
        await abrirNo(page, no);
        await page.getByTestId("acao-0-tipo").selectOption("add_tags");
        await page.getByTestId("acao-0-alvo").selectOption("lead");
        await page.locator("#acao-0-tags").fill(tag);
        await fecharPainel(page);
      }

      // ── Ligações ──
      await ligar(page, "n1", pergunta);
      await ligar(page, pergunta, mensagem, "else");
      for (const ramo of ["no_reply", "invalida", "erro"]) await ligar(page, pergunta, fim, ramo);
      await ligar(page, mensagem, tagMoradia, idMoradia);
      await ligar(page, mensagem, tagInvestimento, idInvestimento);
      await ligar(page, mensagem, fimSemResposta, "no_reply");
      for (const ramo of ["else", "erro"]) await ligar(page, mensagem, fim, ramo);
      for (const no of [tagMoradia, tagInvestimento]) {
        await ligar(page, no, fim, "else");
        await ligar(page, no, fim, "erro");
      }
      await page.getByTestId("auto-fit-flow").click();
      await page.waitForTimeout(500);
      await foto(page, "01-editor-com-o-fluxo-montado");

      // ── 4. Publicar e iniciar pela tela ──
      await page.getByTestId("publish-button").click();
      await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
      await expect(page.locator('[data-testid^="node-error-"]')).toHaveCount(0);
      await expect(page.getByTestId("testar-automacao")).toBeEnabled({ timeout: PRAZO });

      const iniciarPara = async (telefone: string): Promise<void> => {
        await page.getByTestId("testar-automacao").click();
        await page.getByTestId("testar-busca").fill(telefone.slice(-8));
        const linha = page.getByTestId("testar-resultados").locator("li").filter({ hasText: telefone.slice(-8) });
        await expect(linha).toHaveCount(1, { timeout: PRAZO });
        await linha.getByRole("button", { name: "Iniciar" }).click();
        await expect(page.getByTestId("testar-busca")).toHaveCount(0, { timeout: PRAZO });
      };
      await iniciarPara(telefoneMaria);
      await iniciarPara(telefoneJoao);
      await relogio(page);

      const enviosPara = (telefone: string) => envios.filter((e) => e.chatId === `${telefone}@c.us`).map((e) => e.text);
      await expect.poll(() => enviosPara(telefoneMaria), { timeout: PRAZO }).toContain("Qual é o seu nome?");
      expect(enviosPara(telefoneJoao)).toContain("Qual é o seu nome?");

      // ── 5. As respostas entram pelo webhook; o relógio as processa ──
      // O WAHA manda o horário em SEGUNDOS: responder no mesmo segundo do envio
      // desenharia a resposta antes da pergunta na conversa. Gente leva mais que isso.
      await page.waitForTimeout(1_200);
      await inbound(telefoneMaria, "Maria", "Maria Souza");
      await inbound(telefoneJoao, "João", "João Pereira");
      await relogio(page);
      const numerado = "Qual o propósito do imóvel?\n\n1) Moradia\n2) Investimento";
      await expect.poll(() => enviosPara(telefoneMaria), { timeout: PRAZO }).toContain(numerado);
      await expect.poll(() => enviosPara(telefoneJoao), { timeout: PRAZO }).toContain(numerado);
      const enviadaAoJoaoEm = Date.now();

      await page.waitForTimeout(1_200);
      await inbound(telefoneMaria, "Maria", "2");
      await relogio(page);

      // ── 6. A consequência, lida pelas rotas da tela ──
      const contatoDe = async (telefone: string): Promise<string> => {
        const r = await page.request.get(`/api/v1/contacts?search=${telefone.slice(-8)}&limit=5`);
        const lista = ((await r.json()) as { data: Array<{ id: string; phone_number: string | null }> }).data;
        const c = lista.find((x) => (x.phone_number ?? "").replace(/\D/g, "").endsWith(telefone.slice(-8)));
        expect(c, `contato ${telefone}`).toBeTruthy();
        return c!.id;
      };
      const mariaId = await contatoDe(telefoneMaria);
      const negocioDaMaria = async () => {
        const r = await page.request.get(`/api/v1/contacts/${mariaId}/crm-summary`);
        const leads = ((await r.json()) as { data: { leads: Array<{ id: string; custom_fields: Record<string, unknown> | null }> } })
          .data.leads;
        return leads[0]!;
      };
      await expect.poll(async () => (await negocioDaMaria()).custom_fields?.nome_informado, { timeout: PRAZO }).toBe(
        "Maria Souza",
      );
      const leadDaMaria = (await negocioDaMaria()).id;
      const { data: tagsLidas } = await banco
        .from("crm_leads")
        .select("tags")
        .eq("organization_id", creds.org_id)
        .eq("id", leadDaMaria)
        .single();
      const tags = ((tagsLidas as { tags?: string[] } | null)?.tags ?? []) as string[];
      expect(tags).toContain("investimento");
      expect(tags).not.toContain("moradia");

      // A conversa no Inbox mostra a pergunta e as opções numeradas.
      const { data: conversa } = await banco
        .from("conversations")
        .select("id")
        .eq("organization_id", creds.org_id)
        .eq("contact_id", mariaId)
        .eq("channel_session_id", sessaoId)
        .single();
      const conversaId = (conversa as { id: string }).id;
      await page.goto(`/app/inbox?id=${conversaId}&filter=all`);
      const thread = page.getByTestId("chat-thread");
      await expect(thread).toBeVisible({ timeout: PRAZO });
      await expect(thread.getByText("Qual é o seu nome?")).toBeVisible({ timeout: PRAZO });
      await expect(thread.getByText(/1\) Moradia/)).toBeVisible();
      await expect(thread.getByText(/2\) Investimento/)).toBeVisible();
      await expect(thread.getByText("Maria Souza")).toBeVisible();
      await foto(page, "04-conversa-no-inbox");

      // O negócio na tela: o campo e a tag.
      await page.goto(`/app/leads/${leadDaMaria}`);
      const campoNaTela = page.getByRole("textbox", { name: "Nome informado" });
      await expect(campoNaTela).toHaveValue("Maria Souza", { timeout: PRAZO });
      await expect(page.getByRole("checkbox", { name: "investimento" })).toBeChecked();
      await page.getByRole("checkbox", { name: "investimento" }).scrollIntoViewIfNeeded();
      fs.mkdirSync(EVIDENCIA, { recursive: true });
      await page.screenshot({ path: path.join(EVIDENCIA, "05a-negocio-com-a-tag.png") });
      await campoNaTela.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(EVIDENCIA, "05b-negocio-com-o-campo.png") });

      // A execução da Maria, em português, sem o texto dela nos eventos.
      await page.goto(`/app/automacoes/${automacaoId}/execucoes`);
      const linhas = page.getByTestId("lista-de-execucoes").getByRole("link");
      await expect(linhas).toHaveCount(2, { timeout: PRAZO });
      await foto(page, "06-lista-de-execucoes");
      await linhas.filter({ hasText: "Maria" }).first().click();
      await page.waitForURL(/\/app\/ai\/followups\/enrollments\/[0-9a-f-]+$/, { timeout: PRAZO });
      const timeline = page.getByTestId("dossie-timeline");
      await expect(timeline).toBeVisible({ timeout: PRAZO });
      await expect(timeline.getByText("Resposta do contato: registrada").first()).toBeVisible();
      await expect(timeline.getByText("Resposta do contato: escolheu “Investimento”")).toBeVisible();
      await expect(timeline.getByText("foi para Enviar mensagem").first()).toBeVisible();
      const historia = (await timeline.textContent()) ?? "";
      expect(historia, "o nome digitado pelo contato não entra nos eventos").not.toContain("Maria Souza");
      expect(historia.match(UUID_RX), "uuid na história da execução").toBeNull();
      expect(historia, "id interno da opção na tela").not.toMatch(/opcao_[a-z0-9]+/);
      expect((await page.locator("main").textContent())?.match(UUID_RX) ?? null, "uuid na tela").toBeNull();
      await foto(page, "07-execucao-em-portugues");

      // ── 7. O João não escolhe nada: depois de 1 minuto, "Sem resposta". ──
      const falta = enviadaAoJoaoEm + 65_000 - Date.now();
      if (falta > 0) await page.waitForTimeout(falta);
      await relogio(page);
      const joaoId = await contatoDe(telefoneJoao);
      const { data: execucaoDoJoao } = await banco
        .from("followup_enrollments")
        .select("id, status")
        .eq("organization_id", creds.org_id)
        .eq("contact_id", joaoId)
        .eq("pointer_id", automacaoId)
        .single();
      const joao = execucaoDoJoao as { id: string; status: string };
      await expect
        .poll(
          async () =>
            ((await banco.from("followup_enrollments").select("status").eq("id", joao.id).single()).data as { status: string })
              .status,
          { timeout: PRAZO },
        )
        .not.toMatch(/^(active|waiting_reply)$/);
      await page.goto(`/app/ai/followups/enrollments/${joao.id}`);
      const timelineDoJoao = page.getByTestId("dossie-timeline");
      await expect(timelineDoJoao.getByText("foi para Sem resposta do contato")).toBeVisible({ timeout: PRAZO });
      expect((await timelineDoJoao.textContent()) ?? "").not.toContain("João Pereira");
      await foto(page, "08-execucao-sem-resposta");
      // O João não ganhou tag nenhuma.
      const { data: leadsDoJoao } = await banco
        .from("crm_leads")
        .select("tags")
        .eq("organization_id", creds.org_id)
        .eq("contact_id", joaoId);
      for (const l of (leadsDoJoao ?? []) as Array<{ tags: string[] | null }>) {
        expect(l.tags ?? []).not.toContain("investimento");
        expect(l.tags ?? []).not.toContain("moradia");
      }
    } finally {
      await new Promise<void>((resolve) => receptor.close(() => resolve()));
      // O número de teste sai da Central (arquivado, como a tela faz), para não
      // aparecer nas specs seguintes que listam canais.
      await banco
        .from("channel_sessions")
        .update({ archived_at: new Date().toISOString(), status: "STOPPED" } as never)
        .eq("organization_id", creds.org_id)
        .eq("id", sessaoId);
    }
  });
});
