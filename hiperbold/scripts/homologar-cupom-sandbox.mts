/**
 * Prova no SANDBOX do Asaas do desenho do cupom de desconto (migration 0955): a assinatura de cartão é criada
 * no PREÇO CHEIO do ciclo (é o valor das renovações), a PRIMEIRA cobrança que o Asaas gera é rebaixada para o
 * total com desconto por `POST /payments/{id}` (`atualizarValorDaCobranca` do cliente do projeto), e o link da
 * fatura continua o mesmo.
 *
 * Confere pela API que:
 *   (a) a primeira cobrança ficou com o valor descontado e o MESMO invoiceUrl de antes da atualização;
 *   (b) a assinatura continua com o valor cheio (as renovações cobram o preço cheio);
 *   (c) o que `fn_billing_asaas_aplicar_pagamento` lê da cobrança (`coalesce(originalValue, value)`) é o valor
 *       descontado, não o cheio (senão a primeira cobrança viraria divergente_valor);
 *   (d) cartão PARCELADO com cupom (anual em 3x e semestral em 4x, este com juros): a cobrança parcelada é criada
 *       com o total que o pedido guardaria em `amount_cents` (juros sobre o preço JÁ descontado) e o Asaas
 *       devolve o mesmo total no parcelamento (`GET /installments/{id}`), com o número certo de parcelas, a soma
 *       das parcelas igual ao total e nenhuma parcela abaixo de R$ 5,00.
 *
 * Depois APAGA tudo o que criou (assinatura e cliente), mesmo se uma conferência falhar.
 *
 * ═══ Trava de sandbox (não negociável) ═══
 * Recusa rodar se `ASAAS_BASE_URL` não for exatamente https://api-sandbox.asaas.com/v3 ou se `ASAAS_API_KEY`
 * não começar com `$aact_hmlg_`. Nunca fala com produção, nunca lê `.env.production`, nunca imprime a chave: a
 * saída passa por `sanitizar()`.
 *
 * ═══ Como rodar (na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/homologar-cupom-sandbox.mts
 *
 * Variáveis opcionais:
 *   HOMOLOG_ENV_DIR   pasta de onde carregar o `.env.local` (padrão: a raiz do repositório). Serve a um
 *                     worktree que não tem o próprio `.env.local`.
 *   HOMOLOG_DIR       onde gravar o resultado (padrão ~/temp/AAAA-MM-DD/cupons/sandbox).
 *
 * O `server-only` do projeto não existe fora do Next: um hook de resolução o aponta para o módulo vazio do
 * próprio Next, como faz o `vitest.config.ts`. Dados de teste: CPF válido GERADO, e-mail em example.com,
 * notificationDisabled: true. Nenhum dado real de pessoa.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeModule from "node:module";

const require = createRequire(import.meta.url);
const RAIZ = process.cwd();

const VAZIO = pathToFileURL(join(RAIZ, "node_modules/next/dist/compiled/server-only/empty.js")).href;
(nodeModule as unknown as {
  registerHooks: (h: {
    resolve: (spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) => unknown;
  }) => void;
}).registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "server-only") return { url: VAZIO, shortCircuit: true, format: "commonjs" };
    return next(spec, ctx);
  },
});

const { loadEnvConfig } = require(
  require.resolve("@next/env", { paths: [require.resolve("next", { paths: [RAIZ] })] }),
) as { loadEnvConfig: (dir: string, dev: boolean, log: { info(): void; error(): void }) => unknown };
loadEnvConfig(process.env.HOMOLOG_ENV_DIR ?? RAIZ, true, { info() {}, error() {} });

const BASE_SANDBOX = "https://api-sandbox.asaas.com/v3";
const CHAVE = (process.env.ASAAS_API_KEY ?? "").trim();
const BASE = (process.env.ASAAS_BASE_URL ?? "").trim();

if (BASE !== BASE_SANDBOX || !CHAVE.startsWith("$aact_hmlg_")) {
  console.error(
    "[homologar-cupom] RECUSADO: só roda com ASAAS_BASE_URL=" +
      BASE_SANDBOX +
      " e ASAAS_API_KEY começando com $aact_hmlg_. Nada foi chamado.",
  );
  process.exit(2);
}

type Dict = Record<string, unknown>;

function sanitizar(valor: unknown): unknown {
  const texto = JSON.stringify(valor ?? null).split(CHAVE).join("<chave>");
  return JSON.parse(texto) as unknown;
}
function log(msg: string): void {
  console.log(msg.split(CHAVE).join("<chave>"));
}

const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const DIR = process.env.HOMOLOG_DIR ?? join(homedir(), "temp", hoje, "cupons", "sandbox");
mkdirSync(DIR, { recursive: true });

function cpfGerado(): string {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (n.every((x) => x === n[0])) n[8] = (n[8]! + 1) % 10;
  const dv = (arr: number[]): number => {
    let s = 0;
    for (let i = 0; i < arr.length; i += 1) s += arr[i]! * (arr.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(n);
  const d2 = dv([...n, d1]);
  return [...n, d1, d2].join("");
}

/** Chamada direta, só para o que o cliente do projeto não cobre (criar cliente com notificações desligadas, apagar). */
async function direto(metodo: "GET" | "POST" | "DELETE", caminho: string, corpo?: unknown): Promise<{ status: number; corpo: Dict }> {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { access_token: CHAVE, "Content-Type": "application/json", "User-Agent": "HiperCRM/1.0" },
    ...(metodo === "GET" || metodo === "DELETE" ? {} : { body: JSON.stringify(corpo ?? {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text();
  let json: unknown = texto;
  try {
    json = JSON.parse(texto);
  } catch {
    /* não é JSON */
  }
  return { status: res.status, corpo: sanitizar(json) as Dict };
}

const { calcularParcelamento } = (await import(
  pathToFileURL(join(RAIZ, "lib/billing/asaas/parcelamento.ts")).href
)) as typeof import("../../lib/billing/asaas/parcelamento");

const { criarClienteAsaas } = (await import(
  pathToFileURL(join(RAIZ, "lib/billing/asaas/cliente.ts")).href
)) as typeof import("../../lib/billing/asaas/cliente");

const cliente = criarClienteAsaas({
  fetch: globalThis.fetch,
  config: { habilitado: true, baseUrl: BASE, apiKey: CHAVE, webhookToken: "", webhookId: "", ambiente: "sandbox" },
  logger: {
    warn: (m, c) => log(`[aviso] ${m} ${JSON.stringify(c ?? {})}`),
    error: (m, c) => log(`[erro] ${m} ${JSON.stringify(c ?? {})}`),
  },
});

// R$ 100,00 cheio, 10% de desconto: a primeira cobrança vai a R$ 90,00. O preço cheio é o das renovações.
const PRECO_CHEIO = 100;
const TOTAL_COM_DESCONTO = 90;

const resultado: Dict = { inicio: new Date().toISOString(), base: BASE, precoCheio: PRECO_CHEIO, totalComDesconto: TOTAL_COM_DESCONTO };
const conferencias: Array<{ nome: string; ok: boolean; detalhe?: unknown }> = [];
function conferir(nome: string, ok: boolean, detalhe?: unknown): void {
  conferencias.push({ nome, ok, detalhe });
  log(`${ok ? "OK    " : "FALHOU"} ${nome}${detalhe === undefined ? "" : " " + JSON.stringify(sanitizar(detalhe))}`);
}

let clienteId: string | null = null;
let assinaturaId: string | null = null;
const parcelamentosCriados: string[] = [];
let falhou = false;

try {
  const ts = Date.now();
  const criado = await direto("POST", "/customers", {
    name: `Homologação cupom HiperCRM ${hoje}`,
    cpfCnpj: cpfGerado(),
    email: `homolog-cupom-${ts}@example.com`,
    externalReference: `HC:homolog:cupom:cli:${ts}`,
    notificationDisabled: true,
  });
  if (criado.status !== 200) throw new Error(`criar cliente: ${criado.status} ${JSON.stringify(criado.corpo)}`);
  clienteId = criado.corpo.id as string;
  log(`cliente de teste criado: ${clienteId}`);

  // 1. Assinatura MENSAL de cartão no PREÇO CHEIO, pelo cliente do projeto (o mesmo caminho de compra.ts).
  const assinatura = await cliente.criarAssinatura({
    customer: clienteId,
    billingType: "CREDIT_CARD",
    value: PRECO_CHEIO,
    nextDueDate: hoje,
    cycle: "MONTHLY",
    description: "Homologação do cupom (sandbox)",
    externalReference: `HC:homolog:cupom:${ts}`,
  });
  assinaturaId = assinatura.id;
  resultado.assinaturaCriada = { id: assinatura.id, value: assinatura.value, cycle: assinatura.cycle };
  conferir("a assinatura nasceu no preço cheio", assinatura.value === PRECO_CHEIO, { value: assinatura.value });

  // 2. A primeira cobrança que o Asaas gerou (pode demorar um instante).
  let primeira = (await cliente.listarCobrancasDaAssinatura(assinatura.id))[0] ?? null;
  for (let i = 0; i < 5 && !primeira; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    primeira = (await cliente.listarCobrancasDaAssinatura(assinatura.id))[0] ?? null;
  }
  if (!primeira) throw new Error("o Asaas não gerou a primeira cobrança da assinatura em 10 s");
  resultado.primeiraAntes = { id: primeira.id, status: primeira.status, value: primeira.value, invoiceUrl: primeira.invoiceUrl };
  conferir("a primeira cobrança está PENDING no preço cheio", primeira.status === "PENDING" && primeira.value === PRECO_CHEIO, {
    status: primeira.status,
    value: primeira.value,
  });
  conferir("a primeira cobrança tem invoiceUrl do sandbox", /^https:\/\/sandbox\.asaas\.com\//.test(primeira.invoiceUrl ?? ""), {
    invoiceUrl: primeira.invoiceUrl,
  });
  const urlAntes = primeira.invoiceUrl;

  // 3. Rebaixa a primeira cobrança ao total com desconto (o método novo do cliente do projeto).
  const atualizada = await cliente.atualizarValorDaCobranca(primeira.id, { value: TOTAL_COM_DESCONTO });
  resultado.respostaDaAtualizacao = { id: atualizada.id, status: atualizada.status, value: atualizada.value, originalValue: atualizada.originalValue ?? null, invoiceUrl: atualizada.invoiceUrl };
  conferir("a resposta da atualização traz o valor descontado", atualizada.value === TOTAL_COM_DESCONTO, { value: atualizada.value });

  // 4. Relê pela API (nada de confiar na resposta da atualização).
  const relida = await direto("GET", `/payments/${primeira.id}`);
  const listada = (await cliente.listarCobrancasDaAssinatura(assinatura.id)).find((c) => c.id === primeira!.id) ?? null;
  const assinaturaDepois = await direto("GET", `/subscriptions/${assinatura.id}`);
  resultado.relido = {
    cobranca: { id: relida.corpo.id, status: relida.corpo.status, value: relida.corpo.value, originalValue: relida.corpo.originalValue ?? null, netValue: relida.corpo.netValue, invoiceUrl: relida.corpo.invoiceUrl, subscription: relida.corpo.subscription },
    assinatura: { id: assinaturaDepois.corpo.id, status: assinaturaDepois.corpo.status, value: assinaturaDepois.corpo.value, cycle: assinaturaDepois.corpo.cycle, nextDueDate: assinaturaDepois.corpo.nextDueDate },
  };

  conferir("(a) a primeira cobrança ficou com o valor descontado (GET /payments/{id})", relida.corpo.value === TOTAL_COM_DESCONTO, { value: relida.corpo.value });
  conferir("(a) e a lista da assinatura também mostra o valor descontado", listada?.value === TOTAL_COM_DESCONTO, { value: listada?.value });
  conferir("(a) o invoiceUrl é o mesmo de antes da atualização", relida.corpo.invoiceUrl === urlAntes && listada?.invoiceUrl === urlAntes, {
    antes: urlAntes,
    depois: relida.corpo.invoiceUrl,
  });
  conferir("(a) a cobrança continua PENDING e ligada à assinatura", relida.corpo.status === "PENDING" && relida.corpo.subscription === assinatura.id, {
    status: relida.corpo.status,
  });
  conferir("(b) a assinatura continua com o valor cheio", assinaturaDepois.corpo.value === PRECO_CHEIO, { value: assinaturaDepois.corpo.value });
  conferir("(b) e continua mensal e ativa", assinaturaDepois.corpo.cycle === "MONTHLY" && assinaturaDepois.corpo.status === "ACTIVE", {
    cycle: assinaturaDepois.corpo.cycle,
    status: assinaturaDepois.corpo.status,
  });
  const lidoPeloBanco = (relida.corpo.originalValue as number | null | undefined) ?? (relida.corpo.value as number);
  conferir("(c) o valor que a conciliação lê (originalValue, senão value) é o descontado", lidoPeloBanco === TOTAL_COM_DESCONTO, {
    originalValue: relida.corpo.originalValue ?? null,
    value: relida.corpo.value,
  });

  // 6. Cartão parcelado com cupom: o total é o do pedido (juros sobre o preço já descontado), conferido no Asaas.
  const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };
  const casos = [
    { rotulo: "anual 3x (sem juros)", preco: 189900, parcelas: 3 },
    { rotulo: "semestral 4x (com juros)", preco: 104900, parcelas: 4 },
  ];
  resultado.parcelados = [];
  for (const caso of casos) {
    const desconto = Math.floor((caso.preco * 10 + 50) / 100); // 10%, half-up como o banco
    const amountCents = calcularParcelamento(caso.preco - desconto, caso.parcelas, PARAMETROS).totalCents;
    const semCupomCents = calcularParcelamento(caso.preco, caso.parcelas, PARAMETROS).totalCents;
    const criada = await cliente.criarCobrancaParcelada({
      customer: clienteId,
      billingType: "CREDIT_CARD",
      installmentCount: caso.parcelas,
      totalValue: amountCents / 100,
      dueDate: hoje,
      description: `Homologação do cupom, ${caso.rotulo} (sandbox)`,
      externalReference: `HC:homolog:cupom:parc:${caso.parcelas}:${ts}`,
    });
    const installmentId = criada.installment ?? null;
    if (!installmentId) throw new Error(`parcelado ${caso.rotulo}: o Asaas não devolveu o id do parcelamento`);
    parcelamentosCriados.push(installmentId);

    const parcelamento = await cliente.buscarParcelamento(installmentId);
    const parcelas = "removido" in parcelamento ? [] : await cliente.listarCobrancasDoParcelamento(installmentId);
    const somaCents = parcelas.reduce((acc, p) => acc + Math.round(p.value * 100), 0);
    const menorParcela = parcelas.length ? Math.min(...parcelas.map((p) => Math.round(p.value * 100))) : 0;
    (resultado.parcelados as unknown[]).push({
      caso: caso.rotulo,
      amountCentsEsperado: amountCents,
      semCupomCents,
      totalNoAsaas: "removido" in parcelamento ? null : parcelamento.value,
      parcelasNoAsaas: parcelas.map((p) => p.value),
    });

    conferir(`(d) ${caso.rotulo}: o total do parcelamento no Asaas é igual ao amount_cents do pedido`, !("removido" in parcelamento) && Math.round(parcelamento.value * 100) === amountCents, {
      amountCents,
      asaas: "removido" in parcelamento ? null : parcelamento.value,
    });
    conferir(`(d) ${caso.rotulo}: o total é menor que o do mesmo parcelamento sem cupom`, amountCents < semCupomCents, { amountCents, semCupomCents });
    conferir(`(d) ${caso.rotulo}: ${caso.parcelas} parcelas, somando o total, nenhuma abaixo de R$ 5,00`, parcelas.length === caso.parcelas && somaCents === amountCents && menorParcela >= 500, {
      quantidade: parcelas.length,
      somaCents,
      menorParcela,
    });
    conferir(`(d) ${caso.rotulo}: as parcelas são do mesmo parcelamento e estão pendentes`, parcelas.every((p) => p.installment === installmentId && p.status === "PENDING"), {
      status: parcelas.map((p) => p.status),
    });
  }
} catch (err) {
  falhou = true;
  const e = err as { erro?: unknown; message?: string };
  log(`[erro] ${JSON.stringify(sanitizar(e.erro ?? e.message ?? String(err)))}`);
  resultado.erro = sanitizar(e.erro ?? e.message ?? String(err));
} finally {
  // 5. Apaga tudo o que criou, mesmo com falha acima.
  const limpeza: Dict = {};
  if (assinaturaId) {
    const r = await direto("DELETE", `/subscriptions/${assinaturaId}`);
    limpeza.assinatura = { id: assinaturaId, status: r.status, deleted: r.corpo.deleted ?? null };
    const conferida = await direto("GET", `/subscriptions/${assinaturaId}`);
    limpeza.assinaturaDepois = { status: conferida.status, deleted: conferida.corpo.deleted ?? null };
  }
  if (parcelamentosCriados.length > 0) {
    const removidos: Dict[] = [];
    for (const id of parcelamentosCriados) {
      const r = await direto("DELETE", `/installments/${id}`);
      removidos.push({ id, status: r.status, deleted: r.corpo.deleted ?? null });
    }
    limpeza.parcelamentos = removidos;
  }
  if (clienteId) {
    const r = await direto("DELETE", `/customers/${clienteId}`);
    limpeza.cliente = { id: clienteId, status: r.status, deleted: r.corpo.deleted ?? null };
  }
  resultado.limpeza = limpeza;
  const apagada = (item: unknown): boolean => {
    const x = item as { status?: number; deleted?: unknown } | undefined;
    return x?.status === 200 && x?.deleted === true;
  };
  const tudoApagado =
    (!assinaturaId || apagada(limpeza.assinatura)) &&
    (!clienteId || apagada(limpeza.cliente)) &&
    ((limpeza.parcelamentos as unknown[] | undefined) ?? []).every(apagada);
  conferir("limpeza: assinatura, parcelamentos e cliente de teste apagados", Boolean(tudoApagado), limpeza);
}

resultado.conferencias = conferencias;
resultado.fim = new Date().toISOString();
writeFileSync(join(DIR, "homologar-cupom-resultado.json"), JSON.stringify(sanitizar(resultado), null, 2));

const reprovadas = conferencias.filter((c) => !c.ok);
log(`\n${conferencias.length - reprovadas.length}/${conferencias.length} conferências OK. Resultado em ${DIR}`);
process.exit(falhou || reprovadas.length > 0 ? 1 : 0);
