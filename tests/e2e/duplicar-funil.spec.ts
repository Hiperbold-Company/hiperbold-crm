/**
 * DUPLICAR FUNIL E O ACORDEÃO DA PÁGINA DE ETAPAS, PELA TELA.
 *
 * A jornada de quem abre um funil por edição ("PMA 2027" → "PMA 2028"): a página
 * de Etapas do funil mostra os funis FECHADOS (com mais de um), a pessoa abre o
 * que quer pelo cabeçalho, pelo "Abrir todos" ou por um link com hash, e duplica
 * um funil configurado — pelo botão do topo e pelo botão do card — sem refazer
 * etapas, motivos de perda e campos à mão.
 *
 * O que só a tela responde (os testes de componente rodam em jsdom, com a API
 * fingida): o funil novo aparece ABERTO depois do `router.refresh()`, com as
 * etapas, os motivos e os campos lidos de volta do banco pela própria página; e a
 * recusa de nome repetido chega ao diálogo como frase, não como `HTTP 409`.
 *
 * A fixture é um funil PRÓPRIO desta spec (prefixo "Dup E2E"), semeado e apagado
 * por ela, junto com as cópias — o mesmo padrão de `motivos-de-perda-do-funil.spec.ts`.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/duplicar-funil.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Locator, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/duplicar-funil");
const ESPERA = 30_000;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);
const PREFIXO = "Dup E2E";
const ORIGEM = `${PREFIXO} ${SUFIXO} PMA 2027`;
const COPIA_PELO_TOPO = `${PREFIXO} ${SUFIXO} PMA 2028`;
const COPIA_PELO_CARD = `${ORIGEM} (cópia)`;
const ETAPAS = ["Inscrito", "Matriculado", "Desistiu"];
const MOTIVOS = ["Sem orçamento", "Fora do perfil"];
const CAMPO = { key: "turma", label: "Turma do programa", type: "text" };

let origemId = "";

/**
 * Admin, não manager: motivos de perda e campos do lead são do editor de configuração, que só o admin vê.
 * O admin do seed tem TOTP; o helper trata a janela do código e o fator rotacionado por outra sessão.
 */
async function entrarComoAdmin(page: Page): Promise<void> {
  const atuais = await loginComoAdmin(page, creds as unknown as CredsE2E);
  creds = { ...creds, ...(atuais as unknown as Partial<Creds>) };
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", `${PREFIXO} %`);
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

async function idDoFunilPeloNome(nome: string): Promise<string> {
  const { data, error } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .eq("name", nome)
    .eq("is_archived", false)
    .single();
  if (error) throw new Error(`funil «${nome}»: ${error.message}`);
  return (data as { id: string }).id;
}

/** O cabeçalho do card (o botão que abre e fecha). */
const cabecalho = (page: Page, id: string) => page.getByTestId(`alternar-funil-${id}`);
const corpo = (page: Page, id: string) => page.locator(`#corpo-do-funil-${id}`);

/** Os valores de todos os campos de texto do card — é o que o dono do funil lê. */
async function valoresDoCard(card: Locator): Promise<string[]> {
  return card.locator("input").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}

/** O que o card mostra: as etapas (em ordem), os motivos e os rótulos dos campos. */
async function configuracaoNaTela(page: Page, id: string) {
  const card = page.getByTestId(`funil-${id}`);
  // O upstream (#3176) só monta o editor do funil depois do clique em "abrir editor".
  await card.getByTestId(`abrir-editor-${id}`).click();
  await expect(card.getByTestId(`area-do-editor-${id}`)).toBeVisible({ timeout: ESPERA });
  // As etapas chegam por fetch depois que o card aparece: esperar a lista, não ler o "carregando".
  await expect(card.locator('[data-testid^="nome-"]')).toHaveCount(ETAPAS.length, { timeout: ESPERA });
  const etapas = await card
    .locator('[data-testid^="nome-"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  return { etapas, valores: await valoresDoCard(card) };
}

test.describe("Duplicar funil e o acordeão da página de Etapas", () => {
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limparFixtures();

    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: ORIGEM,
        slug: `dup-e2e-${SUFIXO}`,
        // As duas chaves que a tela de Funis grava: é delas que a cópia tem de nascer.
        settings: { lost_reasons: MOTIVOS, fields: [CAMPO] },
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil: ${error.message}`);
    origemId = (funil as { id: string }).id;

    for (const [i, nome] of ETAPAS.entries()) {
      const { error: erroEtapa } = await admin.from("crm_stages").insert({
        organization_id: creds.org_id,
        pipeline_id: origemId,
        name: nome,
        slug: `${nome.toLowerCase()}-${SUFIXO}`,
        position: (i + 1) * 1000,
        is_lost: nome === "Desistiu",
      });
      if (erroEtapa) throw new Error(`etapa ${nome}: ${erroEtapa.message}`);
    }
  });

  test.afterAll(async () => {
    if (creds) await limparFixtures();
  });

  test("os funis nascem fechados e abrem pelo cabeçalho, pelo Abrir todos e pelo hash", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await entrarComoAdmin(page);
    await page.goto("/app/settings/tenant/pipelines");

    // Mais de um funil na organização: todos os cards fechados, cabeçalho à vista.
    const cabecalhos = page.locator('[data-testid^="alternar-funil-"]');
    await expect(cabecalho(page, origemId)).toBeVisible({ timeout: ESPERA });
    expect(await cabecalhos.count(), "a organização de E2E precisa de 2+ funis").toBeGreaterThan(1);
    for (const estado of await cabecalhos.evaluateAll((els) => els.map((e) => e.getAttribute("aria-expanded")))) {
      expect(estado).toBe("false");
    }
    await expect(corpo(page, origemId)).toBeHidden();
    // O cabeçalho diz quantas etapas o funil tem, mesmo fechado.
    await expect(cabecalho(page, origemId)).toContainText(`${ETAPAS.length} etapas`);
    await captura(page, "01-funis-fechados");

    // Abre pelo cabeçalho.
    await cabecalho(page, origemId).click();
    await expect(cabecalho(page, origemId)).toHaveAttribute("aria-expanded", "true");
    await expect(corpo(page, origemId)).toBeVisible();
    await expect(page.getByTestId(`etapas-${origemId}`)).toBeVisible();
    await captura(page, "02-um-funil-aberto");
    await cabecalho(page, origemId).click();
    await expect(corpo(page, origemId)).toBeHidden();

    // Abrir todos / Fechar todos.
    const alternarTodos = page.getByTestId("alternar-todos-os-funis");
    await expect(alternarTodos).toHaveText("Abrir todos");
    await alternarTodos.click();
    await expect(alternarTodos).toHaveText("Fechar todos");
    for (const estado of await cabecalhos.evaluateAll((els) => els.map((e) => e.getAttribute("aria-expanded")))) {
      expect(estado).toBe("true");
    }
    await alternarTodos.click();
    await expect(alternarTodos).toHaveText("Abrir todos");
    await expect(corpo(page, origemId)).toBeHidden();

    // Pelo hash, na abertura da página: o link "ir para as etapas" leva ao lugar certo.
    await page.goto(`/app/settings/tenant/pipelines#etapas-${origemId}`);
    await expect(cabecalho(page, origemId)).toHaveAttribute("aria-expanded", "true", { timeout: ESPERA });
    await expect(page.getByTestId(`etapas-${origemId}`)).toBeInViewport({ timeout: ESPERA });
    await captura(page, "03-aberto-pelo-hash");
  });

  test("duplica pelo topo e pelo card; o funil novo vem aberto e com a configuração", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await entrarComoAdmin(page);
    await page.goto("/app/settings/tenant/pipelines");
    await expect(cabecalho(page, origemId)).toBeVisible({ timeout: ESPERA });

    // ---- 1. pelo botão do topo, escolhendo a origem ----
    await page.getByTestId("duplicar-funil").click();
    const dialogo = page.getByTestId("dialogo-duplicar-funil");
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText("Negócios, automações e formulários não são copiados.");
    await dialogo.getByTestId("duplicar-origem").click();
    await page.getByRole("option", { name: ORIGEM, exact: true }).click();
    // O nome acompanha a origem enquanto a pessoa não o editou.
    await expect(dialogo.getByTestId("duplicar-nome")).toHaveValue(COPIA_PELO_CARD);
    await captura(page, "04-dialogo-origem-escolhida");
    await dialogo.getByTestId("duplicar-nome").fill(COPIA_PELO_TOPO);
    await dialogo.getByTestId("duplicar-salvar").click();
    await expect(dialogo).toBeHidden({ timeout: ESPERA });
    await expect(page.getByText(`«${COPIA_PELO_TOPO}» foi criado`)).toBeVisible({ timeout: ESPERA });

    const novoId = await idDoFunilPeloNome(COPIA_PELO_TOPO);
    await expect(cabecalho(page, novoId)).toHaveAttribute("aria-expanded", "true", { timeout: ESPERA });
    await expect(page.getByTestId(`etapas-${novoId}`)).toBeVisible({ timeout: ESPERA });
    // A origem continua fechada: só o recém-duplicado abriu.
    await expect(cabecalho(page, origemId)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId(`funil-${novoId}`)).toBeInViewport({ timeout: ESPERA });

    const naTela = await configuracaoNaTela(page, novoId);
    expect(naTela.etapas, "as mesmas etapas, na mesma ordem").toEqual(ETAPAS);
    expect(naTela.valores, "os motivos de perda").toContain(MOTIVOS.join(", "));
    expect(naTela.valores, "o campo do lead (chave)").toContain(CAMPO.key);
    expect(naTela.valores, "o campo do lead (rótulo)").toContain(CAMPO.label);
    await captura(page, "05-copia-pelo-topo-aberta");

    // O banco confirma o que a tela leu, e a origem não foi tocada.
    const { data: copia } = await admin.from("crm_pipelines").select("settings").eq("id", novoId).single();
    const settings = (copia as { settings: { lost_reasons?: unknown; fields?: Array<{ key: string }> } }).settings;
    expect(settings.lost_reasons).toEqual(MOTIVOS);
    expect(settings.fields?.map((f) => f.key)).toEqual([CAMPO.key]);
    const { count: etapasDaOrigem } = await admin
      .from("crm_stages")
      .select("id", { count: "exact", head: true })
      .eq("pipeline_id", origemId);
    expect(etapasDaOrigem).toBe(ETAPAS.length);

    // ---- 2. nome repetido: a recusa chega como frase ----
    await page.getByTestId(`duplicar-funil-${origemId}`).click();
    await expect(dialogo).toBeVisible();
    await dialogo.getByTestId("duplicar-nome").fill(COPIA_PELO_TOPO);
    await dialogo.getByTestId("duplicar-salvar").click();
    const erro = dialogo.getByTestId("duplicar-erro");
    await expect(erro).toBeVisible({ timeout: ESPERA });
    await expect(erro).toContainText(`Já existe um funil chamado «${COPIA_PELO_TOPO}»`);
    await expect(erro).not.toContainText(/HTTP \d+/);
    await expect(dialogo, "o diálogo continua aberto para corrigir").toBeVisible();
    await captura(page, "06-erro-nome-repetido");
    await dialogo.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialogo).toBeHidden();

    // ---- 3. pelo botão do card, com a origem já escolhida ----
    await page.getByTestId(`duplicar-funil-${origemId}`).click();
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByTestId("duplicar-origem")).toContainText(ORIGEM);
    await expect(dialogo.getByTestId("duplicar-nome")).toHaveValue(COPIA_PELO_CARD);
    await dialogo.getByTestId("duplicar-salvar").click();
    await expect(dialogo).toBeHidden({ timeout: ESPERA });

    const doCardId = await idDoFunilPeloNome(COPIA_PELO_CARD);
    await expect(cabecalho(page, doCardId)).toHaveAttribute("aria-expanded", "true", { timeout: ESPERA });
    const doCard = await configuracaoNaTela(page, doCardId);
    expect(doCard.etapas).toEqual(ETAPAS);
    expect(doCard.valores).toContain(MOTIVOS.join(", "));
    expect(doCard.valores).toContain(CAMPO.label);
    await captura(page, "07-copia-pelo-card-aberta");

    // Recarregar a página: a lista volta fechada (o recém-duplicado não é estado permanente).
    await page.reload();
    await expect(cabecalho(page, doCardId)).toHaveAttribute("aria-expanded", "false", { timeout: ESPERA });
  });
});
