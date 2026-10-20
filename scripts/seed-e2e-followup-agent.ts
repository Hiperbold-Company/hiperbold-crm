/**
 * Seed E2E de fixtures pro editor de mcp_agent (Task 7.2 — seletor de fluxo
 * de follow-up): 1 `ai_provider_credentials` + 1 `channel_sessions`, os 2
 * FKs `not null` que `POST /api/v1/ai/agents` (Mode B) exige pra criar um
 * agent+v1 draft. Não existe fixture pronta pra isso no repo (grep
 * confirmou) — os testes de agente existentes não cobrem a criação via UI/API
 * ainda. Mesmo padrão de scripts/seed-e2e-queue.ts (idempotente por
 * label/session_name únicos, service role, grava bloco em .e2e-creds.json).
 *
 * A credential nasce SEM `validated_at` (não precisamos publicar o agent
 * nesta task, só salvar draft — publish é que exige credential validada).
 * `api_key_encrypted/iv/tag` recebem bytea placeholder (nunca decifrados nos
 * caminhos exercitados pelo teste).
 *
 * Run: npx tsx scripts/seed-e2e-followup-agent.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, ignorando o ambiente — e
// por isso a suíte E2E semeava no banco de PRODUÇÃO mesmo com o `.env.e2e`
// injetado no webServer do Playwright: este script nunca olhava para lá.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-followup-agent", credenciais);
const env = {
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
} as Record<string, string>;

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const CREDENTIAL_LABEL = "E2E Followup Agent Credential";
// A credencial CONECTADA (ativa e validada): é a que o formulário do agente aceita. Desde 20/10/2026 o
// campo "Empresa de inteligência artificial" só oferece a chave do plano (OpenRouter, que o ambiente do
// e2e não tem de propósito: a VPS fresca da parte 4 modela instalação sem chave) e os provedores com
// credencial validada. Spec que EDITA um agente pela tela precisa de uma versão com esta credencial; a de
// cima segue sem validação porque outras specs dependem de a publicação recusá-la.
const CREDENTIAL_CONECTADA_LABEL = "E2E Credencial Conectada";
const SESSION_NAME = "e2e-followup-agent-session";

interface Creds {
  org_id: string;
  followup_agent_fixtures?: unknown;
}

async function ensureCredential(
  orgId: string,
  label: string = CREDENTIAL_LABEL,
  conectada: boolean = false,
): Promise<string> {
  const { data: existing } = await admin
    .from("ai_provider_credentials")
    .select("id, validated_at")
    .eq("organization_id", orgId)
    .eq("label", label)
    .maybeSingle();
  if (existing) {
    const linha = existing as { id: string; validated_at: string | null };
    if (conectada && !linha.validated_at) {
      const { error } = await admin
        .from("ai_provider_credentials")
        .update({ validated_at: new Date().toISOString(), validation_error: null } as never)
        .eq("id", linha.id);
      if (error) throw new Error(`validar ai_provider_credentials: ${error.message}`);
    }
    return linha.id;
  }

  const { data, error } = await admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: orgId,
      provider: "anthropic",
      label,
      api_key_encrypted: "\\x00",
      api_key_iv: "\\x00",
      api_key_tag: "\\x00",
      api_key_last4: "e2e1",
      is_active: true,
      ...(conectada ? { validated_at: new Date().toISOString() } : {}),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert ai_provider_credentials: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureChannelSession(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSION_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: SESSION_NAME,
      display_name: "Número Follow-up Agent E2E",
      webhook_secret_encrypted: "\\x00",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert channel_sessions: ${error?.message}`);
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const credentialId = await ensureCredential(orgId);
  const credentialConectadaId = await ensureCredential(orgId, CREDENTIAL_CONECTADA_LABEL, true);
  const channelSessionId = await ensureChannelSession(orgId);

  creds.followup_agent_fixtures = {
    credential_id: credentialId,
    credential_conectada_id: credentialConectadaId,
    channel_session_id: channelSessionId,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(
    `\n✅ Followup agent fixtures seed completo. credential=${credentialId} channel_session=${channelSessionId}`,
  );
}

main().catch((err) => {
  console.error("❌ Followup agent fixtures seed falhou:", err);
  process.exit(1);
});
