/**
 * PERMISSÕES POR PERFIL — pela tela, como um administrador leigo faria.
 *
 *  1. O administrador abre Equipe › Permissões, liga "Exportar contatos (CSV)"
 *     para o Atendente e salva.
 *  2. O atendente vê "Exportar CSV" em Contatos e a exportação baixa o arquivo
 *     (a ROTA aceita — não é só o botão).
 *  3. O administrador restaura o padrão e salva.
 *  4. O atendente não vê mais o botão, e a rota recusa com 403
 *     `forbidden_permission`.
 *
 * Usuários do seed (`scripts/seed-e2e-credentials.ts`); o admin tem TOTP.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

function loadCreds(): E2ECreds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.agent || !c.users?.admin || !c.admin_totp?.secret;
  };
  if (precisa())
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();
const NOME = `Permissões e2e ${Date.now()}`;

async function entrar(page: Page, email: string, totp?: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\/|\/login\/mfa/, { timeout: 30_000 });
  if (!/\/login\/mfa/.test(page.url())) return;
  if (!totp) throw new Error(`${email} caiu na MFA sem segredo TOTP`);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(totp), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA falhou em 2 tentativas");
}

const celula = (page: Page, chave: string, papel: string) =>
  page.locator(`[data-capacidade="${chave}"] [role="switch"][data-papel="${papel}"]`);

async function abrirPermissoes(page: Page): Promise<void> {
  await page.goto("/app/team");
  await page.getByRole("tab", { name: "Permissões" }).click();
  await expect(page.getByTestId("permissoes-por-perfil")).toBeVisible();
}

async function salvar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Permissões salvas.")).toBeVisible({ timeout: 15_000 });
}

/** Deixa a organização no padrão — também no começo, para uma rodada anterior interrompida não contaminar esta. */
async function restaurarPadrao(page: Page): Promise<void> {
  await abrirPermissoes(page);
  const restaurar = page.getByRole("button", { name: "Restaurar padrão" });
  if (await restaurar.isEnabled()) {
    await restaurar.click();
    await salvar(page);
  }
  await expect(celula(page, "contatos.exportar", "agent")).not.toBeChecked();
}

async function exportarPeloAtendente(page: Page): Promise<number> {
  const r = await page.request.post("/api/v1/contacts/export", { data: { ids: [contatoId] } });
  return r.status();
}

let contatoId = "";

test.describe.serial("permissões por perfil — Exportar CSV para o Atendente", () => {
  test("admin libera, atendente exporta; admin restaura, atendente não vê", async ({ browser }) => {
    const admin = await (await browser.newContext()).newPage();
    const atendente = await (await browser.newContext()).newPage();

    await entrar(admin, creds.users.admin!.email, creds.admin_totp?.secret);
    await restaurarPadrao(admin);

    await entrar(atendente, creds.users.agent!.email);
    const criado = await atendente.request.post("/api/v1/contacts", {
      data: { display_name: NOME, source: "manual" },
    });
    expect(criado.status(), "não deu para criar o contato de teste").toBe(201);
    contatoId = ((await criado.json()) as { data: { contact: { id: string } } }).data.contact.id;

    // Controle: no padrão o atendente não exporta — nem pelo botão, nem pela rota.
    expect(await exportarPeloAtendente(atendente)).toBe(403);

    // 1. Admin liga "Exportar contatos (CSV)" para Atendente e salva.
    await abrirPermissoes(admin);
    await expect(admin.getByText("Administrador sempre pode tudo.")).toBeVisible();
    // Célula fora do liberável é cadeado, não switch.
    await expect(
      admin.locator('[data-capacidade="funis.editar"] [data-trava="agent"]'),
    ).toBeVisible();
    await celula(admin, "contatos.exportar", "agent").click();
    await expect(celula(admin, "contatos.exportar", "agent")).toBeChecked();
    await salvar(admin);
    await admin.screenshot({
      path: "evidence/permissoes-por-perfil/01-admin-liberou.png",
      fullPage: true,
    });

    // 2. Atendente vê o botão e a exportação funciona.
    await atendente.goto(`/app/contacts?search=${encodeURIComponent(NOME)}`);
    await atendente.getByRole("checkbox", { name: `Selecionar ${NOME}` }).check();
    const botao = atendente.getByRole("button", { name: "Exportar CSV" });
    await expect(botao).toBeVisible();
    const download = atendente.waitForEvent("download");
    await botao.click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    expect(await exportarPeloAtendente(atendente)).toBe(200);
    await atendente.screenshot({
      path: "evidence/permissoes-por-perfil/02-atendente-exporta.png",
      fullPage: true,
    });

    // 3. Admin restaura o padrão.
    await restaurarPadrao(admin);

    // 4. Atendente não vê mais, e a rota recusa.
    await atendente.goto(`/app/contacts?search=${encodeURIComponent(NOME)}`);
    await expect(atendente.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });
    await expect(atendente.getByRole("button", { name: "Exportar CSV" })).toHaveCount(0);
    const recusa = await atendente.request.post("/api/v1/contacts/export", {
      data: { ids: [contatoId] },
    });
    expect(recusa.status()).toBe(403);
    expect(((await recusa.json()) as { error: { code: string } }).error.code).toBe(
      "forbidden_permission",
    );
    await atendente.screenshot({
      path: "evidence/permissoes-por-perfil/03-atendente-sem-botao.png",
      fullPage: true,
    });
  });
});
