/**
 * Corrige os leads que JÁ chegaram pela captação (webhook de entrada) com os campos fora do lugar:
 * "Empresa"/"Cargo" gravados sob o rótulo cru em `custom_fields`, e UTMs só em `source_metadata`, enquanto o
 * funil declara `empresa`, `cargo`, `utm_source`... e a ficha do negócio lê pela `key`.
 *
 * Usa a MESMA função da rota de captação (`lib/webhooks/encaixar-campos.ts`), então o que o script arruma é
 * exatamente o que a captação passou a fazer sozinha.
 *
 * ═══ Como rodar (na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/corrigir-campos-da-captacao.mts \
 *       --org-slug <slug> --db-url <postgres://...>                 # dry-run (padrão): só conta, nada é gravado
 *   ... --aplicar                                                    # grava, numa transação só
 *   Banco que não é local (host diferente de 127.0.0.1/localhost/::1) exige, além do --aplicar ou não:
 *   ... --producao   com   CONFIRMO_PRODUCAO=sim   no ambiente
 *
 * ═══ O que faz ═══
 * Para cada lead da organização cuja `source` é 'webhook' (só os que vieram da captação; manual, automação, API, WhatsApp e importação ficam de fora), no funil do próprio lead:
 *   - move cada chave de `custom_fields` que case com um campo do funil (key, rótulo, ou rótulo antes de " / ";
 *     sem caixa/acento) para a `key` do campo, QUANDO a key está vazia; a chave crua só sai se o valor foi copiado;
 *   - copia UTMs e ids de clique de `source_metadata` para `custom_fields` quando o funil declara o campo e ele
 *     está vazio (`source_metadata` não é alterado).
 * Nunca sobrescreve valor existente. Idempotente: a segunda execução muda 0 leads.
 *
 * ═══ Garantias ═══
 *   - dry-run é o PADRÃO: roda tudo dentro de uma transação e dá ROLLBACK;
 *   - tudo filtrado por `organization_id` (resolvido pelo slug) — nenhuma outra organização é lida nem gravada;
 *   - só `crm_leads.custom_fields` é escrito (e o `updated_at` do gatilho). Nada de etapa, status, dono ou
 *     atividade: nenhum evento nem automação dispara;
 *   - a saída são CONTAGENS. Nunca nome, e-mail, telefone, valor de campo, string de conexão ou senha.
 */
import pg from "pg";

import { camposDoFunil } from "../../lib/leads/campos-do-funil";
import { encaixarCamposNoFunil } from "../../lib/webhooks/encaixar-campos";

// ─── Argumentos ────────────────────────────────────────────────────────────────
function valorDe(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}
const ORG_SLUG = valorDe("--org-slug");
const DB_URL = valorDe("--db-url");
const APLICAR = process.argv.includes("--aplicar") && !process.argv.includes("--dry-run");
const PRODUCAO = process.argv.includes("--producao");

function recusar(motivo: string): never {
  console.error(`[campos-da-captacao] RECUSADO: ${motivo} Nada foi lido nem gravado.`);
  process.exit(2);
}

if (!ORG_SLUG) recusar("falta --org-slug.");
if (!DB_URL) recusar("falta --db-url.");

let host: string;
try {
  host = new URL(DB_URL).hostname.replace(/^\[|\]$/g, "");
} catch {
  recusar("--db-url não é uma URL de conexão válida.");
}
const LOCAL = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOCAL.has(host)) {
  if (!PRODUCAO) recusar(`o host "${host}" não é local; para banco de produção use --producao.`);
  if (process.env.CONFIRMO_PRODUCAO !== "sim") {
    recusar("--producao exige CONFIRMO_PRODUCAO=sim no ambiente.");
  }
}

const SEM_DADO = "[campos-da-captacao]";

/** JSON com as chaves em ordem: o jsonb do Postgres não preserva a ordem de inserção, então comparar o texto cru enganaria. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function iguais(a: unknown, b: unknown): boolean {
  return canonico(a) === canonico(b);
}

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const cliente = new pg.Client({ connectionString: DB_URL });
try {
  await cliente.connect();
} catch {
  console.error(`${SEM_DADO} não consegui conectar ao banco (host ${host}).`);
  process.exit(1);
}

let lidos = 0;
let comMudanca = 0;
let camposMovidos = 0;
let utmsCopiadas = 0;
let semCamposNoFunil = 0;
let gravados = 0;

try {
  await cliente.query("begin");
  await cliente.query("set local statement_timeout = '120s'");

  const org = await cliente.query<{ id: string }>("select id from organizations where slug = $1", [ORG_SLUG]);
  if (org.rowCount !== 1) {
    await cliente.query("rollback");
    console.error(`${SEM_DADO} organização "${ORG_SLUG}" não encontrada. Nada foi gravado.`);
    process.exit(2);
  }
  const orgId = org.rows[0]!.id;

  const funis = await cliente.query<{ id: string; settings: unknown }>(
    "select id, settings from crm_pipelines where organization_id = $1",
    [orgId],
  );
  const camposPorFunil = new Map<string, ReturnType<typeof camposDoFunil>>();
  for (const f of funis.rows) camposPorFunil.set(f.id, camposDoFunil(objeto(f.settings)));

  // Em modo de gravação, trava as linhas lidas: um lead mexido por outra sessão no meio não é sobrescrito.
  const leads = await cliente.query<{
    id: string;
    pipeline_id: string;
    custom_fields: unknown;
    source_metadata: unknown;
  }>(
    `select id, pipeline_id, custom_fields, source_metadata
       from crm_leads
      where organization_id = $1
        and source = 'webhook'
      order by id
      ${APLICAR ? "for update" : ""}`,
    [orgId],
  );

  for (const lead of leads.rows) {
    lidos += 1;
    const campos = camposPorFunil.get(lead.pipeline_id) ?? [];
    if (campos.length === 0) {
      semCamposNoFunil += 1;
      continue;
    }
    const antes = objeto(lead.custom_fields);
    const r = encaixarCamposNoFunil({
      campos: antes,
      rastreamento: objeto(lead.source_metadata),
      funil: campos,
    });
    if (iguais(antes, r.custom_fields)) continue;

    comMudanca += 1;
    camposMovidos += r.movidos;
    utmsCopiadas += r.rastreamentoCopiado;
    if (APLICAR) {
      const gravou = await cliente.query(
        "update crm_leads set custom_fields = $1::jsonb where organization_id = $2 and id = $3",
        [JSON.stringify(r.custom_fields), orgId, lead.id],
      );
      gravados += gravou.rowCount ?? 0;
    }
  }

  await cliente.query(APLICAR ? "commit" : "rollback");
} catch (erro) {
  try {
    await cliente.query("rollback");
  } catch {
    /* a conexão já caiu: o banco desfaz sozinho */
  }
  const codigo = (erro as { code?: string }).code ?? "sem código";
  console.error(`${SEM_DADO} falhou (${codigo}); a transação foi desfeita, nada foi gravado.`);
  await cliente.end().catch(() => undefined);
  process.exit(1);
}

await cliente.end();
console.info(
  `${SEM_DADO} ${APLICAR ? "APLICADO" : "dry-run (nada gravado)"} org=${ORG_SLUG}: ` +
    `leads_lidos=${lidos} leads_com_mudanca=${comMudanca} campos_movidos=${camposMovidos} ` +
    `utms_copiadas=${utmsCopiadas} leads_em_funil_sem_campos=${semCamposNoFunil} leads_gravados=${gravados}`,
);
process.exit(0);
