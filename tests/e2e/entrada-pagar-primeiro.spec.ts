/**
 * E2E — O CAMINHO "PAGA PRIMEIRO": do link do site ao Início, sem passar pelo wizard.
 *
 * Decisão do dono do produto (15/10/2026): o cliente escolhe o plano no site, cria a conta e cai direto
 * no pagamento. Quem não pagou não entra. Pago, entra no CRM pela tela Início.
 *
 *   /signup?plano=max → empresa criada → /onboarding/plano (Max marcado, sem indicador de passos)
 *   → Pix gerado, ainda não pago → qualquer /app/* e /onboarding/* volta ao pagamento
 *   → contrato ativo → /app/inicio (onboarding concluído sem tela final)
 *
 * ─── Por que esta spec está FORA do CI ──────────────────────────────────────
 *
 * Ela precisa de três coisas que o job de e2e não tem, e nenhuma é dado que a spec possa semear:
 *
 *  1. o servidor do app NASCENDO com `ASAAS_ENABLED=true` e uma chave de SANDBOX do Asaas (o Pix só nasce
 *     de uma chamada real ao sandbox; `ASAAS_BASE_URL` de sandbox);
 *  2. o provedor de auth com "Confirm email" DESLIGADO (`GOTRUE_MAILER_AUTOCONFIRM=true`), como em
 *     `cadastro-sem-confirmacao-de-email`: é o estado de produção que esta versão liga;
 *  3. `billing_settings` com `modo = 'bloquear'` e `compra_pelo_cliente = true` e os planos `pro`, `max` e
 *     `escale` à venda — a spec liga o que é do BANCO (e devolve no fim), mas não o que é do ambiente.
 *
 * Ligar isso no `.env.e2e` de todas as partes mudaria o que as outras specs medem. O que roda todo dia no
 * `verify` e guarda cada peça desta jornada:
 *   - `tests/unit/onboarding-roteador-paga-primeiro.test.ts` (o roteador: pagamento, conclusão, Início)
 *   - `lib/onboarding/passos.test.ts` (o wizard se reduz ao passo de pagamento)
 *   - `tests/unit/onboarding-destino-e-retorno.test.ts` (pré-seleção do plano, URL de retorno do cartão)
 *   - `tests/unit/asaas-compra-retorno-do-cartao.test.ts` (o corpo que sai para o Asaas)
 *
 * Para rodá-la: suba o app com as três coisas acima e rode só este arquivo:
 *
 *   pnpm exec playwright test tests/e2e/entrada-pagar-primeiro.spec.ts
 *
 * A "confirmação do pagamento" é simulada pelo mesmo caminho do pagamento registrado na mão
 * (`fn_billing_registrar_pagamento`, migration 0908): o contrato vira `ativa`. O que o webhook do Asaas faz
 * por cima disso (marcar o PEDIDO como pago) é provado por `asaas-*` e pela homologação no sandbox; aqui o
 * que se mede é o que a PESSOA vê. Cada precondição é CONFERIDA e a spec falha alto: uma que se auto-pula
 * leria como "a jornada está boa".
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { test, expect } from "./helpers/test";

const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = createClient(URL_SUPABASE, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const SENHA = "PagarPrimeiro!2026#Deskcomm";
const NOME_DA_EMPRESA = "Loja Paga Primeiro E2E";
const CPF_DE_TESTE = "111.444.777-35";

const usuariosCriados: string[] = [];
const orgsCriadas: string[] = [];
let configuracaoAnterior: Record<string, unknown> | null = null;

test.beforeAll(async () => {
  const r = await fetch(`${URL_SUPABASE}/auth/v1/settings`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
  });
  const settings = (await r.json()) as { mailer_autoconfirm?: boolean };
  expect(
    settings.mailer_autoconfirm,
    "precondição ausente: o provedor local exige confirmação de e-mail. Ver o cabeçalho desta spec.",
  ).toBe(true);

  const { data } = await svc.from("billing_settings").select("modo, compra_pelo_cliente").eq("id", 1).maybeSingle();
  configuracaoAnterior = data as Record<string, unknown> | null;
  const { error } = await svc.from("billing_settings").update({ modo: "bloquear", compra_pelo_cliente: true }).eq("id", 1);
  expect(error, "não consegui ligar a compra pelo cliente no banco local").toBeNull();

  const { data: planos } = await svc.from("billing_plans").select("code, for_sale").in("code", ["pro", "max", "escale"]);
  expect(
    (planos ?? []).filter((p) => p.for_sale).map((p) => p.code).sort(),
    "precondição ausente: os planos pro, max e escale precisam estar à venda no banco local",
  ).toEqual(["escale", "max", "pro"]);
});

test.afterAll(async () => {
  if (configuracaoAnterior) {
    await svc.from("billing_settings").update(configuracaoAnterior).eq("id", 1);
  }
  for (const id of orgsCriadas) {
    await svc.from("billing_orders").delete().eq("organization_id", id);
    await svc.from("billing_payments").delete().eq("organization_id", id);
    await svc.from("user_organizations").delete().eq("organization_id", id);
    await svc.from("crm_stages").delete().eq("organization_id", id);
    await svc.from("crm_pipelines").delete().eq("organization_id", id);
    await svc.from("organizations").delete().eq("id", id);
  }
  for (const id of usuariosCriados) await svc.auth.admin.deleteUser(id);
});

test("⭐ do link do site (?plano=max) ao Início: paga primeiro, nada de wizard", async ({ page }) => {
  test.setTimeout(180_000);
  const email = `paga-primeiro-${randomUUID().slice(0, 8)}@qa.local`;

  // ── Cadastro: o plano do site viaja no link ────────────────────────────
  await page.goto("/signup?plano=max");
  await page.locator("#org_name").fill(NOME_DA_EMPRESA);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.locator("#password_confirm").fill(SENHA);
  await page.locator("#aceite_termos").check();
  await page.getByRole("button", { name: /criar conta/i }).click();

  await expect(page).toHaveURL(/\/get-started/, { timeout: 30_000 });
  await page.getByRole("button", { name: /Continuar para o onboarding/i }).click();

  // ── Cai no pagamento: nem boas-vindas, nem WhatsApp, nem treino ────────
  await expect(page, "a empresa nova tem de cair no pagamento").toHaveURL(/\/onboarding\/plano/, { timeout: 40_000 });
  await expect(page.getByRole("heading", { name: "Escolha seu plano" })).toBeVisible();
  // Única etapa: sem indicador de passos. O cabeçalho traz a logo e o nome da empresa.
  await expect(page.getByRole("list", { name: "onboarding steps" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: NOME_DA_EMPRESA })).toBeVisible();

  const { data: usuarios } = await svc.auth.admin.listUsers();
  const usuario = usuarios.users.find((u) => u.email === email);
  expect(usuario, "o usuário não chegou ao banco").toBeTruthy();
  usuariosCriados.push(usuario!.id);
  const { data: vinculo } = await svc.from("user_organizations").select("organization_id").eq("user_id", usuario!.id).single();
  const orgId = (vinculo as { organization_id: string }).organization_id;
  orgsCriadas.push(orgId);

  // ── O plano do site chega marcado ─────────────────────────────────────
  await expect(page.getByTestId("plano-max")).toHaveClass(/border-primary/);
  await expect(page.getByTestId("plano-pro")).not.toHaveClass(/border-primary/);
  await expect(page.getByTestId("plano-escale")).not.toHaveClass(/border-primary/);

  // ── Pix gerado e ainda não pago ───────────────────────────────────────
  await page.getByTestId("escolher-max").click();
  await page.getByTestId("continuar").click(); // ciclo mensal
  await page.getByTestId("metodo-PIX").click();
  const cpf = page.locator('input[id$="-documento"]');
  if (await cpf.count()) {
    await page.locator('input[id$="-nome"]').fill("Dono da Loja");
    await cpf.fill(CPF_DE_TESTE);
  }
  await page.locator('[id^="termos-plano-"]').click();
  await page.getByTestId("continuar").click();
  await page.getByTestId("assinar-max").click();
  await expect(page.getByText(/aguardando a confirmação do pagamento/i)).toBeVisible({ timeout: 60_000 });

  // ── Sem pagar, o CRM e o resto do wizard ficam fechados ───────────────
  for (const destino of ["/app/inbox", "/app/inicio", "/onboarding/connect-whatsapp", "/onboarding/done"]) {
    await page.goto(destino);
    await expect(page, `${destino} abriu sem o pagamento`).toHaveURL(/\/onboarding\/plano/, { timeout: 30_000 });
  }
  // E a volta à tela mostra o pedido pendente, não o formulário de novo.
  await expect(page.getByTestId("plano-aguardando-pagamento")).toBeVisible();

  // ── Pagamento confirmado (contrato ativo): entra pelo Início ──────────
  const fim = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const { error } = await svc.rpc("fn_billing_registrar_pagamento", {
    p_org: orgId,
    p_fim: fim,
    p_valor_cents: 39_900,
    p_chave: randomUUID(),
    p_nota: "e2e entrada-pagar-primeiro",
    p_actor: usuario!.id,
  });
  expect(error, "não consegui simular o pagamento confirmado").toBeNull();

  await page.goto("/onboarding/plano");
  await expect(page).toHaveURL(/\/app\/inicio/, { timeout: 40_000 });

  const { data: org } = await svc.from("organizations").select("onboarded_at").eq("id", orgId).single();
  expect((org as { onboarded_at: string | null }).onboarded_at, "o onboarding não foi concluído ao pagar").not.toBeNull();

  // Concluído, o wizard não volta: os endereços dele levam à entrada do CRM.
  await page.goto("/onboarding/connect-whatsapp");
  await expect(page).toHaveURL(/\/app\/(inicio|inbox)/, { timeout: 30_000 });
});
