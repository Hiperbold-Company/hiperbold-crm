/**
 * Prints da demo do site (org demo-site-2026), logado como a dona.
 *   DEMO_URL=http://localhost:3210 PIPE=<id> npx tsx scripts/demo-site/05-prints.mts [slug...]
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = process.env.DEMO_URL ?? "http://localhost:3210";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error(`RECUSADO: app não local (${BASE})`);
const OUT = process.env.OUT ?? `${homedir()}/temp/2026-11-10/d228/prints`;
mkdirSync(OUT, { recursive: true });
const SENHA = readFileSync(`${homedir()}/temp/2026-11-10/d228/demo-senha`, "utf8").trim();
const PIPE = process.env.PIPE!;
const AUTO_BOAS_VINDAS = process.env.AUTO_A!;
const AUTO_IG = process.env.AUTO_IG!;
const AGENTE = process.env.AGENTE!;
const so = new Set(process.argv.slice(2));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: "pt-BR",
  timezoneId: "America/Sao_Paulo",
  colorScheme: "light",
});
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.locator("#email").fill("juliana.ferraz@exemplo.com.br");
await page.locator("#password").fill(SENHA);
await page.getByRole("button", { name: "Entrar", exact: true }).click();
await page.waitForURL(/\/app/, { timeout: 30_000 });

async function pronto(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await p
    .waitForFunction(
      () => !document.querySelector('[data-slot="skeleton"], .animate-pulse, [aria-busy="true"], .animate-spin'),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => console.log("  aviso: ainda havia esqueleto/spinner"));
  await p.waitForTimeout(1200);
  // toasts e avisos flutuantes
  await p.evaluate(() => {
    document.querySelectorAll("[data-sonner-toaster], [data-sonner-toast], nextjs-portal").forEach((e) => e.remove());
    // aviso de versão do rodapé da barra lateral
    for (const el of Array.from(document.querySelectorAll("aside *, nav *"))) {
      const t = (el as HTMLElement).innerText ?? "";
      if (t.includes("Versão ainda não confirmada") && !t.includes("Configurações")) { (el as HTMLElement).style.visibility = "hidden"; break; }
    }
  });
}

async function print(slug: string, url: string, antes?: (p: Page) => Promise<void>) {
  if (so.size && !so.has(slug)) return;
  await page.goto(`${BASE}${url}`);
  await pronto(page);
  if (antes) {
    await antes(page);
    await pronto(page);
  }
  const texto = await page.evaluate(() => document.body.innerText);
  for (const ruim of ["undefined", "NaN", "Erro", "erro inesperado", "Algo deu errado"]) {
    if (texto.includes(ruim)) console.log(`  ATENÇÃO ${slug}: a tela contém "${ruim}"`);
  }
  await page.screenshot({ path: `${OUT}/${slug}.png` });
  console.log(`ok ${slug}.png  (${page.url()})`);
}

await print("crm", `/app/pipelines/${PIPE}`);
await print("agente-de-ia", AGENTE ? `/app/ai/agents/${AGENTE}` : "/app/ai/agents");
await print("atendimento", "/app/inbox", async (p) => {
  await p.getByRole("tab", { name: /Todas/ }).first().click().catch(async () => { await p.getByText(/^Todas/).first().click(); });
  await pronto(p);
  await p.getByText(process.env.CONVERSA ?? "Camila Ribeiro").first().click();
});
await print("automacoes", `/app/automacoes/${AUTO_BOAS_VINDAS}`);
await print("automacoes-instagram", `/app/automacoes/${AUTO_IG}`, async (p) => {
  await p.getByText("Comentário no Instagram").first().click();
});
await print("integracoes", "/app/webhooks?tab=sources");
await print("desempenho", "/app/metrics");

await browser.close();
