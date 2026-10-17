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
 * - A troca pode COLIDIR com `uniq_contacts_org_cpf` (organização + cpf_hash, só contato não mesclado): depois do
 *   deploy, uma captação nova grava o CPF já com o HMAC, e o contato antigo do mesmo CPF (ainda com o hash
 *   antigo) vira duplicata assim que é recalculado. Nesse caso (23505, ou o par achado antes de gravar) a linha NÃO
 *   é trocada: o script lista o par de ids (sem CPF, sem hash) para quem opera mesclar os dois contatos, e sai com
 *   código 1. Qualquer outra recusa do banco é contada como falha e o script segue.
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
const colisoes: Array<[string, string]> = [];
let cursor: string | null = null;
const idsSemCifra: string[] = [];

/** Outro contato ATIVO da mesma organização que já tem este hash (o que `uniq_contacts_org_cpf` protege). */
async function contatoComEsteHash(org: string, hash: string, exceto: string): Promise<string | null> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", org)
    .eq("cpf_hash", hash)
    .is("is_merged_into", null)
    .neq("id", exceto)
    .limit(1);
  return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null;
}

for (;;) {
  let consulta = admin
    .from("contacts")
    .select("id, organization_id, cpf_hash, cpf_encrypted")
    .not("cpf_hash", "is", null)
    .order("id", { ascending: true })
    .limit(LOTE);
  if (cursor) consulta = consulta.gt("id", cursor);
  const { data, error } = await consulta;
  if (error) {
    console.error(`[cpf-hash] leitura falhou (${error.code ?? "sem código"}).`);
    process.exit(1);
  }
  const linhas = (data ?? []) as Array<{
    id: string;
    organization_id: string;
    cpf_hash: string;
    cpf_encrypted: string | null;
  }>;
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
    // Já existe outro contato ativo com o hash novo: trocar este viola uniq_contacts_org_cpf. Vale no dry-run também.
    const outroAntes = await contatoComEsteHash(l.organization_id, novo, l.id);
    if (outroAntes) {
      colisoes.push([l.id, outroAntes]);
      continue;
    }
    if (!APLICAR) {
      recalculados++;
      continue;
    }
    const { error: erroGravar } = await admin.from("contacts").update({ cpf_hash: novo }).eq("id", l.id);
    if (erroGravar?.code === "23505") {
      // Corrida: o outro contato surgiu entre a conferência e a gravação.
      const outro = await contatoComEsteHash(l.organization_id, novo, l.id);
      colisoes.push([l.id, outro ?? "desconhecido"]);
      continue;
    }
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
    `ja_com_hmac=${jaNovos} sem_cifra=${semCifra} colisoes=${colisoes.length} falhas=${falhas}`,
);
for (const [id, outro] of colisoes.slice(0, 200)) {
  log(`[cpf-hash] colisão: o contato ${id} tem o mesmo CPF do contato ${outro} (mesma organização); mesclar os dois, a linha ${id} ficou com o hash antigo`);
}
if (idsSemCifra.length > 0) log(`[cpf-hash] sem cifra (ficam com o hash antigo): ${idsSemCifra.slice(0, 50).join(", ")}`);
process.exit(falhas > 0 || colisoes.length > 0 ? 1 : 0);
