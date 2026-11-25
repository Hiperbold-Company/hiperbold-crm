/**
 * OS MOTIVOS DE PERDA SÃO DA ORGANIZAÇÃO (migration 1021, decisão do dono do produto em 24/11/2026).
 *
 * A fonte é `organizations.settings.lost_reasons` — o MESMO formato que o funil usava (texto puro ou
 * `{ label, categoria }`, até 50). A lista que cada funil tinha em `crm_pipelines.settings.lost_reasons`
 * virou LEGADO: a 1021 a fundiu na lista da organização e o gatilho `fn_validate_lost_reason_required`
 * continua a aceitá-la (negócio histórico e automação publicada não quebram), mas ninguém mais a oferece.
 *
 * ─── Como os leitores antigos passam a ler a organização sem mudar ────────
 *
 * Mais de quinze pontos do produto leem `settings.lost_reasons` de um funil (o quadro, a janela de
 * perder, o filtro e o relatório por categoria, a régua `recusaDeMotivoForaDoVocabulario` de todas as
 * escritas do servidor). Em vez de trocar cada um, as PORTAS que entregam o `settings` do funil
 * (`settingsDoFunil`, o payload do quadro, o resumo do contato, o relatório de perdas) entregam o
 * settings EFETIVO: `lost_reasons` = a lista da organização, e a lista legada do funil em
 * `lost_reasons_do_funil`, que só a ACEITAÇÃO lê (o mesmo que o gatilho faz).
 *
 * ⚠️ O settings efetivo é LEITURA. Ninguém grava de volta no funil o que saiu daqui — quem grava a
 * configuração do funil lê o `settings` cru (`lib/pipelines/configuracao-do-funil.ts`).
 *
 * Organização SEM a chave `lost_reasons` (instalação que ainda não aplicou a 1021, ou organização
 * criada depois dela e que nunca salvou a lista) segue no legado: o settings do funil sai como está.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { atualizarSettingDaOrganizacao } from "@/lib/organizations/atualizar-setting";
import {
  listaDaOrganizacao,
  listaLimpa,
  mesmaLista,
  motivosDaOrganizacaoSchema,
  type MotivoDePerdaGravado,
} from "@/lib/leads/motivos-da-organizacao-regua";

export * from "@/lib/leads/motivos-da-organizacao-regua";

export interface ResultadoDoAcrescimo {
  lista: unknown[];
  mudou: boolean;
  nao_couberam: unknown[];
}

/**
 * Acrescenta à lista da organização SEM apagar os outros (`fn_acrescentar_motivos_de_perda_da_organizacao`,
 * 1021): rótulo que já existe não duplica, a categoria informada substitui a gravada, e o que não cabe
 * no teto de 50 volta em `nao_couberam`. Pede o client de service role; a organização vem de fonte
 * confiável, nunca do corpo.
 */
export async function acrescentarMotivosDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  motivos: readonly MotivoDePerdaGravado[],
): Promise<{ ok: true; dados: ResultadoDoAcrescimo } | { ok: false; erro: string }> {
  const { data, error } = await admin.rpc("fn_acrescentar_motivos_de_perda_da_organizacao", {
    p_org: organizationId,
    p_motivos: motivos,
  });
  if (error) return { ok: false, erro: error.message };
  if (!data || typeof data !== "object") return { ok: false, erro: "organizacao_nao_encontrada" };
  const r = data as Partial<ResultadoDoAcrescimo>;
  return {
    ok: true,
    dados: {
      lista: Array.isArray(r.lista) ? r.lista : [],
      mudou: r.mudou === true,
      nao_couberam: Array.isArray(r.nao_couberam) ? r.nao_couberam : [],
    },
  };
}

export interface AutorDosMotivos {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
}

/** O audit da lista da organização — 1 entrada, só quando a lista mudou. Nunca leva o conteúdo. */
async function auditarMudanca(
  organizationId: string,
  autor: AutorDosMotivos,
  requestId: string | null | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  await audit({
    action: "organization.lost_reasons_updated",
    actorUserId: autor.actorUserId ?? null,
    actorApiTokenId: autor.actorApiTokenId ?? null,
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    requestId: requestId ?? null,
    metadata,
  });
}

export type ResultadoDaGravacaoDosMotivos =
  | { ok: true; lista: MotivoDePerdaGravado[]; mudou: boolean }
  | { ok: false; erro: "validation_failed" | "organizacao_nao_encontrada" | "banco"; detalhe?: unknown };

/**
 * SUBSTITUI a lista da organização — a porta da tela Configurações › Motivos de perda. Grava só a
 * chave `lost_reasons` pelo banco (`fn_atualizar_setting_da_organizacao`, D-132), nunca o `settings`
 * inteiro. Audita 1 vez quando a lista muda; salvar a mesma lista não audita nem grava.
 *
 * O gate (papel, MFA, suporte) é de quem chama; `organizationId` vem da sessão.
 */
export async function salvarMotivosDaOrganizacao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    lista: unknown;
    autor: AutorDosMotivos;
    requestId?: string | null;
  },
): Promise<ResultadoDaGravacaoDosMotivos> {
  const parsed = motivosDaOrganizacaoSchema.safeParse(input.lista);
  if (!parsed.success) return { ok: false, erro: "validation_failed", detalhe: parsed.error.flatten() };
  const nova = listaLimpa(parsed.data);

  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (error) return { ok: false, erro: "banco", detalhe: error.message };
  if (!data) return { ok: false, erro: "organizacao_nao_encontrada" };
  const atual = listaDaOrganizacao((data as { settings?: unknown }).settings);
  if (atual !== null && mesmaLista(atual, nova)) return { ok: true, lista: nova, mudou: false };

  const gravou = await atualizarSettingDaOrganizacao(admin, input.organizationId, ["lost_reasons"], nova);
  if (!gravou.ok) return { ok: false, erro: gravou.motivo, detalhe: gravou.detalhe };

  await auditarMudanca(input.organizationId, input.autor, input.requestId, {
    origem: "configuracoes",
    lost_reasons_count: nova.length,
    antes_count: atual?.length ?? null,
  });
  return { ok: true, lista: nova, mudou: true };
}

/**
 * ACRESCENTA à lista da organização e audita quando mudou — a porta da configuração do FUNIL (rota
 * `PATCH /api/v1/pipelines/[id]/config`, server action e tools MCP), que antes gravava a lista do
 * funil. Nada da lista da organização é apagado por aqui.
 */
export async function acrescentarMotivosDaOrganizacaoComAudit(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    motivos: readonly MotivoDePerdaGravado[];
    autor: AutorDosMotivos;
    requestId?: string | null;
    origem: string;
  },
): Promise<{ ok: true; dados: ResultadoDoAcrescimo } | { ok: false; erro: string }> {
  const r = await acrescentarMotivosDaOrganizacao(admin, input.organizationId, input.motivos);
  if (!r.ok) return r;
  if (r.dados.mudou) {
    await auditarMudanca(input.organizationId, input.autor, input.requestId, {
      origem: input.origem,
      lost_reasons_count: r.dados.lista.length,
      nao_couberam_count: r.dados.nao_couberam.length,
    });
  }
  return r;
}
