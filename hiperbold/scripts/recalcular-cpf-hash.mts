/**
 * Recalcula `contacts.cpf_hash` com o HMAC-SHA256 do servidor (`hashCpf`, `lib/contacts/cpf.ts`), no lugar do
 * SHA-256 puro de antes, que se desfazia por força bruta (o espaço de CPFs é pequeno).
 *
 * A chave (`CPF_ENCRYPTION_KEY`) mora no ambiente do app, não no banco, então a conta não pode ser uma migration:
 * este script lê o CPF cifrado (`cpf_encrypted`), decifra pela função `fn_decrypt_oauth` (só service_role), calcula o
 * HMAC aqui e regrava `cpf_hash`. Roda UMA vez em produção, logo depois do deploy que traz o `hashCpf` novo
 * (até lá, a busca por CPF nos contatos antigos não acha ninguém; nada é perdido).
 *
 * ═══ Como rodar (na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/recalcular-cpf-hash.mts            # dry-run (padrão): só conta
 *   node_modules/.bin/tsx hiperbold/scripts/recalcular-cpf-hash.mts --aplicar  # grava
 *
 * - Idempotente: linha cujo `cpf_hash` já é o HMAC novo é pulada; rodar de novo não muda nada.
 * - Contato SEM `cpf_encrypted` (só o hash antigo, de quando a cifra não existia) não tem como ser recalculado: é
 *   contado e listado só por id; segue com o hash antigo até o CPF ser informado de novo.
 * - A troca é uma bijeção do mesmo CPF, então não cria duplicidade nova (`uniq_contacts_org_cpf`); se o banco
 *   recusar uma linha, ela é contada como falha e o script segue.
 * - Log: só ids de contato e contagens. Nunca CPF, hash, chave nem service role.
 * - Variáveis lidas pelo carregador do Next (`@next/env`), sem abrir arquivo .env à mão. Aponta para o banco do
 *   `.env.local` (dev) ou do ambiente que exportar `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const RAIZ = process.cwd();

const { loadEnvConfig } = require(
  require.resolve("@next/env", { paths: [require.resolve("next", { paths: [RAIZ] })] }),
) as { loadEnvConfig: (dir: string, dev: boolean, log: { info(): void; error(): void }) => unknown };
loadEnvConfig(RAIZ, true, { info() {}, error() {} });

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const CHAVE_DO_CPF = (process.env.CPF_ENCRYPTION_KEY ?? "").trim();
const APLICAR = process.argv.includes("--aplicar");
const LOTE = 500;

// A MESMA conta de `hashCpf` (lib/contacts/cpf.ts). Repetida aqui de propósito: o script não importa código do app.
const DOMINIO = "hiperbold:cpf:hash:v1:";
function hmacDoCpf(cpf: string): string {
  return createHmac("sha256", `${DOMINIO}${CHAVE_DO_CPF}`).update(cpf.replace(/\D/g, "")).digest("hex");
}

function log(msg: string): void {
  let t = msg;
  for (const s of [SERVICE_KEY, CHAVE_DO_CPF]) if (s) t = t.split(s).join("<segredo>");
  console.info(t);
}
function recusar(motivo: string): never {
  console.error(`[cpf-hash] RECUSADO: ${motivo} Nada foi lido nem gravado.`);
  process.exit(2);
}

if (!SUPABASE_URL || !SERVICE_KEY) recusar("faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.");
if (!CHAVE_DO_CPF) recusar("falta CPF_ENCRYPTION_KEY (sem ela o HMAC não existe).");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let lidos = 0;
let jaNovos = 0;
let recalculados = 0;
let semCifra = 0;
let falhas = 0;
let cursor: string | null = null;
const idsSemCifra: string[] = [];

for (;;) {
  let consulta = admin
    .from("contacts")
    .select("id, cpf_hash, cpf_encrypted")
    .not("cpf_hash", "is", null)
    .order("id", { ascending: true })
    .limit(LOTE);
  if (cursor) consulta = consulta.gt("id", cursor);
  const { data, error } = await consulta;
  if (error) {
    console.error(`[cpf-hash] leitura falhou (${error.code ?? "sem código"}).`);
    process.exit(1);
  }
  const linhas = (data ?? []) as Array<{ id: string; cpf_hash: string; cpf_encrypted: string | null }>;
  if (linhas.length === 0) break;

  for (const l of linhas) {
    lidos++;
    cursor = l.id;
    if (!l.cpf_encrypted) {
      semCifra++;
      idsSemCifra.push(l.id);
      continue;
    }
    const { data: claro, error: erroDecifra } = await admin.rpc("fn_decrypt_oauth" as never, {
      ciphertext: l.cpf_encrypted,
    } as never);
    if (erroDecifra || typeof claro !== "string" || claro.replace(/\D/g, "").length !== 11) {
      falhas++;
      log(`[cpf-hash] não decifrou o contato ${l.id}`);
      continue;
    }
    const novo = hmacDoCpf(claro);
    if (novo === l.cpf_hash) {
      jaNovos++;
      continue;
    }
    if (!APLICAR) {
      recalculados++;
      continue;
    }
    const { error: erroGravar } = await admin.from("contacts").update({ cpf_hash: novo }).eq("id", l.id);
    if (erroGravar) {
      falhas++;
      log(`[cpf-hash] banco recusou o contato ${l.id} (${erroGravar.code ?? "sem código"})`);
      continue;
    }
    recalculados++;
  }
}

log(
  `[cpf-hash] ${APLICAR ? "APLICADO" : "dry-run"}: lidos=${lidos} recalculados=${recalculados} ` +
    `ja_com_hmac=${jaNovos} sem_cifra=${semCifra} falhas=${falhas}`,
);
if (idsSemCifra.length > 0) log(`[cpf-hash] sem cifra (ficam com o hash antigo): ${idsSemCifra.slice(0, 50).join(", ")}`);
process.exit(falhas > 0 ? 1 : 0);
