// uso: node capturar.mjs <repo> <baseURL> <saida> <rota1,rota2,...>
// Loga como e2e-admin (seed local), captura cada rota em pt-BR e en, 1440x900 e 390x844.
import { createRequire } from "node:module";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const [repo, base, saida, rotasStr] = process.argv.slice(2);
const require = createRequire(path.join(repo, "package.json"));
const { chromium } = require("@playwright/test");
const creds = JSON.parse(fs.readFileSync(path.join(repo, ".e2e-creds.json"), "utf8"));
function b32(s) { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = ""; for (const c of s.replace(/=+$/, "").toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, "0"); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret) { const t = Math.floor(Date.now() / 30000); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t)); const h = crypto.createHmac("sha1", b32(secret)).update(b).digest(); const o = h[h.length - 1] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0"); }
function idioma(loc) { execFileSync("psql", ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", "-qAtc", `update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || jsonb_build_object('locale','${loc}') where email='${creds.users.admin.email}'`]); }
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(base + "/login");
await page.locator("#email").fill(creds.users.admin.email);
await page.locator("#password").fill(creds.password);
await page.getByRole("button", { name: "Entrar", exact: true }).click();
await page.waitForURL(/\/login\/mfa|\/app/, { timeout: 30000 });
if (/mfa/.test(page.url())) { const s = Math.floor(Date.now() / 1000) % 30; if (s > 25) await page.waitForTimeout((31 - s) * 1000); const d = page.locator('input[aria-label="Dígito 1"]'); await d.waitFor({ state: "visible", timeout: 15000 }); await d.click(); await page.keyboard.type(totp(creds.admin_totp.secret), { delay: 40 }); await page.waitForURL(/\/app\//, { timeout: 30000 }); }
async function trocar(loc) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "/app/inicio", { waitUntil: "networkidle" }).catch(() => {});
  const atual = await page.evaluate(() => document.documentElement.lang);
  if (atual === loc || (loc === "pt-BR" && atual.startsWith("pt"))) return;
  if (!(await page.getByTestId("seletor-de-idioma").first().isVisible().catch(() => false))) await page.getByTestId("menu-do-usuario").first().click();
  await page.getByTestId("seletor-de-idioma").first().click();
  await page.getByTestId("idioma-" + loc).first().click();
  await page.waitForTimeout(4000);
  console.log("idioma", loc, await page.evaluate(() => document.documentElement.lang));
}
fs.mkdirSync(saida, { recursive: true });
const rotas = rotasStr.split(",");
for (const loc of ["pt-BR", "en"]) {
  await trocar(loc);
  for (const [nome, vp] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    await page.setViewportSize(vp);
    for (const r of rotas) {
      await page.goto(base + r, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const arq = path.join(saida, `${r.replace(/^\/app\/?/, "").replace(/\//g, "_") || "app"}-${loc}-${nome}.png`);
      await page.screenshot({ path: arq });
      console.log("ok", arq);
    }
  }
}
await trocar("pt-BR");
await browser.close();
