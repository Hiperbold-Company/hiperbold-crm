/**
 * #2522 — O CPF NASCE CIFRADO OU NASCE AUSENTE: a RPC existe no schema e os DOIS
 * campos ou NENHUM entram na linha.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 * Toda gravação de contato COM CPF falhava em produção — importação CSV,
 * `POST /api/v1/contacts` e edição — com `violates check constraint
 * "contacts_cpf_consistency"`. Duas causas encadeadas, medidas no código:
 *
 *  1. `encryptCpfSql()` chamava a RPC `encrypt_cpf`, que NÃO existia em
 *     `supabase/` (o próprio comentário dizia "not yet provisioned");
 *  2. na falha o código gravava SÓ `cpf_hash`, deixando `cpf_encrypted` nulo —
 *     e o CHECK do baseline exige `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`.
 *
 * O reportante perdeu 496 de 500 linhas na importação e teve de guardar o CPF
 * em texto plano num campo personalizado, sem busca.
 *
 * ─── O que este arquivo cobre ────────────────────────────────────────────────
 * A issue fixa o caminho: "uma migration criando `encrypt_cpf(p_plaintext)` /
 * `decrypt_cpf(...)` com pgcrypto e a chave do ambiente", com a degradação
 * mínima (não preencher `cpf_hash`) como alternativa. Este gate cobra os DOIS
 * lados, porque só um deles reproduz o defeito:
 *
 *  - o SCHEMA: a tripla (migration 0597 + apêndice do baseline + `-- manifest:`),
 *    as assinaturas que o código chama, os grants da sessão e a chave vinda de
 *    `private.app_secrets`/GUC — nunca de literal versionado;
 *  - o CÓDIGO: `camposCpfParaGravar` devolve os dois campos ou `{}`, e nenhum
 *    dos três call sites grava `cpf_hash` sozinho.
 *
 * Estrutural (lê arquivo) + comportamental (módulo puro), sem banco: o CI roda
 * `pnpm test:unit` sem Postgres nenhum — é aqui que o PR é pego.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { camposCpfParaGravar, hashCpf } from "@/lib/contacts/cpf";

// Hiperbold: o hash do CPF é HMAC com a chave do servidor (`CPF_ENCRYPTION_KEY`; sem ela `hashCpf`
// devolve null) e a cifra sai pelo cliente admin (`fn_encrypt_oauth`, só service_role), não pelo
// cliente recebido. O dublê de `supabaseCom` responde pelos dois.
let clienteAdmin: unknown = null;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteAdmin }));
beforeEach(() => {
  vi.stubEnv("CPF_ENCRYPTION_KEY", "chave-de-teste-do-cpf");
});

const SUPABASE = join(process.cwd(), "supabase");
const MIGRACOES = join(SUPABASE, "migrations");
const BASELINE = readFileSync(join(SUPABASE, "baseline.sql"), "utf8");

const ARQUIVO = readdirSync(MIGRACOES).find((f) => /_\d{4}_cpf_.*\.sql$/.test(f)) ?? "";
const MIGRACAO = ARQUIVO ? readFileSync(join(MIGRACOES, ARQUIVO), "utf8") : "";

/** Só o apêndice da 0597 no baseline: afirmar sobre o arquivo INTEIRO (48 mil
 *  linhas, 2,5 MB) mediria o resto do repo — `insert into public.api_audit_log`
 *  e `pgp_sym_decrypt` já existem bem antes dele. */
const INICIO_APENDICE = BASELINE.indexOf(
  "-- ---- cifragem at-rest do CPF: encrypt_cpf / decrypt_cpf (migration 0597",
);
const FIM_APENDICE = BASELINE.indexOf("-- ---- VARREDURA anon:");
const APENDICE = INICIO_APENDICE > 0 ? BASELINE.slice(INICIO_APENDICE, FIM_APENDICE) : "";

/** Falso supabase: só o `.rpc` que `encryptCpfSql` usa. */
function supabaseCom(resposta: { data?: unknown; error?: { message: string } | null }) {
  clienteAdmin = { rpc: async () => resposta };
  return clienteAdmin as never;
}

const ORIGENS = [MIGRACAO, APENDICE];

describe("a migration 0597 cria as RPCs que o código chama (tripla do repo)", () => {
  it("o arquivo existe, com NNNN no nome e a linha `-- manifest:`", () => {
    expect(ARQUIVO, "supabase/migrations/*_NNNN_cpf_*.sql não encontrado").not.toBe("");
    expect(ARQUIVO).toMatch(/^\d{14}_0597_.*\.sql$/);
    expect(MIGRACAO).toMatch(/^-- manifest: \S/m);
  });

  it("as DUAS assinaturas existem na migration e no apêndice do baseline", () => {
    for (const origem of ORIGENS) {
      expect(origem).toContain("create or replace function public.encrypt_cpf(p_plaintext text) returns bytea");
      expect(origem).toContain("create or replace function public.decrypt_cpf(p_contact_id uuid) returns text");
      // pgcrypto é a dependência real do corpo; sem a extensão o `pgp_sym_*`
      // não resolve (forward-fix medido da 0041).
      expect(origem).toContain("pgp_sym_encrypt");
      expect(origem).toContain("pgp_sym_decrypt");
      expect(origem).toMatch(/create extension if not exists pgcrypto with schema extensions/);
    }
  });

  it("no baseline o apêndice entra ANTES da VARREDURA anon, que proíbe `create function` depois dela", () => {
    const posFuncao = BASELINE.indexOf("create or replace function public.encrypt_cpf(");
    const posVarredura = BASELINE.indexOf("-- ---- VARREDURA anon:");
    expect(posFuncao).toBeGreaterThan(0);
    expect(posVarredura).toBeGreaterThan(posFuncao);
  });

  it("a chave vem do ambiente (GUC/private.app_secrets) e nunca de literal versionado", () => {
    for (const origem of ORIGENS) {
      expect(origem).toContain("current_setting('app.cpf_key', true)");
      expect(origem).toContain("private.app_secrets where name = 'cpf_key'");
      // L-09: segredo em SQL versionado é segredo público.
      expect(origem).not.toMatch(/value\s*=\s*'[^']{16,}'/);
    }
  });

  it("sem chave a função levanta a mesma régua da fn_encrypt_oauth, e as grants são da sessão", () => {
    for (const origem of ORIGENS) {
      expect(origem).toContain("CPF_ENCRYPTION_KEY ausente");
      expect(origem).toContain(
        "revoke execute on function public.encrypt_cpf(text) from public, anon",
      );
      expect(origem).toContain(
        "grant  execute on function public.encrypt_cpf(text) to authenticated, service_role",
      );
      expect(origem).toContain(
        "revoke execute on function public.decrypt_cpf(uuid) from public, anon",
      );
      expect(origem).toContain(
        "grant  execute on function public.decrypt_cpf(uuid) to authenticated, service_role",
      );
    }
  });

  it("o decrypt checa tenancy e audita ANTES de devolver o plaintext (spec 02 §2.1)", () => {
    for (const origem of ORIGENS) {
      expect(origem).toContain("select 1 from public.fn_user_org_ids() o where o = v_org");
      expect(origem).toContain("'contact.cpf_decrypted'");
      // Audit antes do retorno: decrypt sem rastro é o que a LGPD não aceita.
      expect(origem.indexOf("insert into public.api_audit_log")).toBeLessThan(
        origem.indexOf("return pgp_sym_decrypt"),
      );
    }
  });
});

describe("o código grava os DOIS campos ou NENHUM (#2522)", () => {
  it("com cifra disponível devolve hash E ciphertext — os dois, juntos", async () => {
    const campos = await camposCpfParaGravar(
      supabaseCom({ data: new Uint8Array([9, 9, 9]), error: null }),
      "529.982.247-25",
    );
    expect(campos.cpf_hash).toBe(hashCpf("529.982.247-25"));
    expect(campos.cpf_encrypted).toBeInstanceOf(Uint8Array);
  });

  it("sem cifra devolve `{}` — nunca cpf_hash sozinho, que é o que o CHECK recusa", async () => {
    const porErro = await camposCpfParaGravar(
      supabaseCom({ error: { message: "PGRST202 — function not found" } }),
      "529.982.247-25",
    );
    expect(porErro).toEqual({});
    expect(porErro).not.toHaveProperty("cpf_hash");
    expect(porErro).not.toHaveProperty("cpf_encrypted");

    // RPC existe mas a chave ainda não foi semeada: `data` nulo.
    const semChave = await camposCpfParaGravar(supabaseCom({ data: null, error: null }), "529.982.247-25");
    expect(semChave).toEqual({});
  });

  // Hiperbold D-216: no fork o CPF não vai no INSERT/UPDATE da sessão (o papel `authenticated` não grava
  // `cpf_hash`/`cpf_encrypted`). Os três call sites (importação, create e patch) cifram pelo helper do servidor
  // (`cifrarCpfDoContato`, que devolve `null` sem a chave) e gravam o PAR pelo `gravarCpfDoContatoPorUsuario`,
  // em vez de `camposCpfParaGravar` do upstream. A garantia cobrada é a mesma: os dois campos ou nenhum.
  it("os TRÊS call sites cifram e gravam o CPF pelo helper do fork (D-216) e nenhum grava hash sozinho", () => {
    const callSites = [
      "app/api/v1/contacts/import/route.ts",
      "app/api/v1/contacts/_handler.ts",
    ];
    for (const caminho of callSites) {
      const fonte = readFileSync(join(process.cwd(), caminho), "utf8");
      expect(fonte, `${caminho}: não importa o helper de CPF do fork`).toMatch(
        /from "@\/lib\/contacts\/cpf-do-contato"/,
      );
      expect(fonte, `${caminho}: sem cifrar o CPF pelo helper`).toContain("cifrarCpfDoContato(");
      expect(fonte, `${caminho}: sem gravar o par pelo helper`).toContain("gravarCpfDoContatoPorUsuario(");
      // Sem a chave de cifra, a linha não grava CPF nenhum (nem só o hash): falha fechada.
      expect(fonte, `${caminho}: não recusa quando a cifra falha`).toMatch(/if \(!cifrado\)/);
      expect(
        fonte,
        `${caminho}: alguém grava cpf_hash sem passar pela paridade dos dois campos`,
      ).not.toMatch(/cpf_hash\s*[=:]\s*hashCpf/);
    }
    // O handler tem DOIS sítios (create e patch) — contados, não presumidos. A importação, um.
    const handler = readFileSync(join(process.cwd(), "app/api/v1/contacts/_handler.ts"), "utf8");
    expect(handler.match(/\bcifrarCpfDoContato\(/g)).toHaveLength(2);
    expect(handler.match(/gravarCpfDoContatoPorUsuario\(/g)).toHaveLength(2);
    const importacao = readFileSync(join(process.cwd(), "app/api/v1/contacts/import/route.ts"), "utf8");
    expect(importacao.match(/\bcifrarCpfDoContato\(/g)).toHaveLength(1);
    expect(importacao.match(/gravarCpfDoContatoPorUsuario\(/g)).toHaveLength(1);
    // E o helper grava os dois campos no MESMO update, nunca um só.
    const helper = readFileSync(join(process.cwd(), "lib/contacts/cpf-do-contato.ts"), "utf8");
    expect(helper).toMatch(/\.update\(\{ cpf_hash: cpf\.hash, cpf_encrypted: cpf\.cifrado \}\)/);
  });
});
