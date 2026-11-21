import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const [repo, base, saida] = process.argv.slice(2);
const require = createRequire(path.join(repo, "package.json")); const { chromium } = require("@playwright/test");
const creds = JSON.parse(fs.readFileSync(path.join(repo, ".e2e-creds.json"), "utf8"));
function b32(s){const a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let bits="";for(const c of s.replace(/=+$/,"").toUpperCase())bits+=a.indexOf(c).toString(2).padStart(5,"0");const o=[];for(let i=0;i+8<=bits.length;i+=8)o.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(o);}
function totp(s){const t=Math.floor(Date.now()/30000);const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(t));const h=crypto.createHmac("sha1",b32(s)).update(b).digest();const o=h[h.length-1]&15;return String(((h.readUInt32BE(o)&0x7fffffff)%1e6)).padStart(6,"0");}
const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(base+"/login"); await page.locator("#email").fill(creds.users.admin.email); await page.locator("#password").fill(creds.password);
await page.getByRole("button",{name:"Entrar",exact:true}).click(); await page.waitForURL(/\/login\/mfa|\/app/);
if (/mfa/.test(page.url())) { const s=Math.floor(Date.now()/1000)%30; if(s>25) await page.waitForTimeout((31-s)*1000); const d=page.locator('input[aria-label="Dígito 1"]'); await d.click(); await page.keyboard.type(totp(creds.admin_totp.secret),{delay:40}); await page.waitForURL(/\/app\//); }
await page.goto(base+"/app/inicio",{waitUntil:"networkidle"});
await page.getByTestId("menu-do-usuario").first().click(); await page.waitForTimeout(500);
await page.screenshot({ path: path.join(saida, "menu-do-usuario-desktop.png") });
await page.getByRole("menuitem", { name: /Meu perfil/ }).first().click();
await page.waitForURL(/settings\/profile/, { timeout: 15000 }).then(()=>console.log("perfil OK", page.url())).catch(()=>console.log("perfil FALHOU", page.url()));
await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base+"/app/inicio",{waitUntil:"networkidle"});
await page.getByRole("button", { name: /^Mais$/ }).last().click(); await page.waitForTimeout(800);
await page.screenshot({ path: path.join(saida, "mais-celular.png") }); console.log("mais OK");
await browser.close();
