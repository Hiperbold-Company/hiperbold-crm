/**
 * A rodada diária de exclusão dos dados depois do cancelamento (migration 0959, D-209), e a exclusão de UMA
 * organização (que o admin da plataforma também chama por "Excluir agora").
 *
 * ─── A ordem de uma rodada ──────────────────────────────────────────────────
 *
 *   1. sincronizar: `fn_exclusao_sincronizar` cria, atualiza e apaga as programações AUTOMÁTICAS conforme os
 *      contratos de hoje (cancelada/suspensa de quem pagou; reativou, sai). N dias vem da configuração.
 *   2. avisar: D-30 e D-7 aos administradores da organização (COB-12, com cópia ao operador), por data e marco.
 *   3. excluir: cada organização vencida, uma por vez, dentro do orçamento da rodada.
 *   4. expurgar: registros fiscais arquivados com mais de 5 anos.
 *
 * ─── A exclusão de uma organização ──────────────────────────────────────────
 *
 *   arquivos do Storage -> conexões no provedor (melhor esforço) -> `fn_exclusao_executar` (a guarda de verdade,
 *   no banco, numa transação) -> recibo ao operador. Se o Storage falha, a organização NÃO é excluída nessa
 *   rodada. Nunca apaga nada que não seja da organização devida: o banco recusa organização não programada,
 *   cancelada, ainda no prazo ou (a automática) reativada.
 *
 * Nada aqui lança; falha vira item no resumo e log. O texto do banco nunca vai para a resposta HTTP.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { criarEnfileiradorDeAvisoDeExclusao } from "@/lib/email/conta-e-cobranca/gatilhos-de-exclusao";
import { enviarReciboDeExclusao, type DadosDoRecibo } from "@/lib/email/conta-e-cobranca/recibo-de-exclusao";
import { logger } from "@/lib/logger";

import { apagarArquivosDaOrganizacao } from "./armazenamento";
import { encerrarConexoesDaOrganizacao } from "./conexoes";
import { avisoDevido, chaveDoAviso, diaCivil, type MarcoDoAviso } from "./datas";

export interface ProgramacaoLida {
  organization_id: string;
  origem: "automatica" | "manual";
  motivo: "cancelada" | "suspensa" | "manual";
  excluir_em: string;
  aviso_30_dias_em: string | null;
  aviso_7_dias_em: string | null;
}

export type ResultadoDaExclusao =
  | { ok: true; resumo: Record<string, unknown> }
  | { ok: false; etapa: "guarda" | "armazenamento" | "banco"; motivo: string };

const COLUNAS = "organization_id, origem, motivo, excluir_em, aviso_30_dias_em, aviso_7_dias_em";

function motivoCurto(erro: unknown): string {
  return erro instanceof Error ? erro.message.replace(/\S+@\S+/g, "***").slice(0, 120) : "erro";
}

/** Passo 1. Devolve as contagens da sincronização, ou `null` quando falhou. */
export async function sincronizarProgramacoes(
  admin: SupabaseClient,
  diasDeGuarda: number,
): Promise<{ programadas: number; atualizadas: number; canceladas_por_reativacao: number } | null> {
  const { data, error } = await admin.rpc("fn_exclusao_sincronizar" as never, { p_dias: diasDeGuarda } as never);
  if (error) {
    logger.error("[exclusao] sincronizar falhou", { codigo: (error as { code?: string }).code ?? null });
    return null;
  }
  const d = data as { programadas?: number; atualizadas?: number; canceladas_por_reativacao?: number } | null;
  return {
    programadas: Number(d?.programadas ?? 0),
    atualizadas: Number(d?.atualizadas ?? 0),
    canceladas_por_reativacao: Number(d?.canceladas_por_reativacao ?? 0),
  };
}

/** Passo 2. Quantos avisos novos entraram na fila. */
export async function enfileirarAvisosDevidos(
  admin: SupabaseClient,
  agora: Date,
  enfileirar = criarEnfileiradorDeAvisoDeExclusao(admin),
): Promise<number> {
  const { data, error } = await admin
    .from("org_exclusoes_programadas" as never)
    .select(COLUNAS)
    .eq("estado", "programada")
    .gt("excluir_em", agora.toISOString())
    .limit(1000);
  if (error) {
    logger.error("[exclusao] ler programações para avisar falhou", { codigo: (error as { code?: string }).code ?? null });
    return 0;
  }
  let novos = 0;
  for (const p of (data as unknown as ProgramacaoLida[] | null) ?? []) {
    const excluirEm = new Date(p.excluir_em);
    const marco: MarcoDoAviso | null = avisoDevido(excluirEm, agora, {
      d30: p.aviso_30_dias_em !== null,
      d7: p.aviso_7_dias_em !== null,
    });
    if (!marco) continue;
    const desfecho = await enfileirar({
      organizationId: p.organization_id,
      chave: chaveDoAviso(excluirEm, marco),
      excluirEm: diaCivil(excluirEm),
      dias: marco === "d7" ? 7 : 30,
      motivo: p.motivo,
    });
    if (desfecho === "falhou") continue;
    if (desfecho === "enfileirado") novos++;
    const coluna = marco === "d7" ? "aviso_7_dias_em" : "aviso_30_dias_em";
    const { error: erroMarca } = await admin
      .from("org_exclusoes_programadas" as never)
      .update({ [coluna]: agora.toISOString() } as never)
      .eq("organization_id", p.organization_id);
    if (erroMarca) {
      logger.warn("[exclusao] marcador do aviso não gravou (a fila de e-mail já é idempotente)", {
        organization_id: p.organization_id,
      });
    }
  }
  return novos;
}

/** Quem está vencido hoje: programada, não cancelada, data passada. */
export async function organizacoesVencidas(admin: SupabaseClient, agora: Date, limite = 20): Promise<ProgramacaoLida[] | null> {
  const { data, error } = await admin
    .from("org_exclusoes_programadas" as never)
    .select(COLUNAS)
    .eq("estado", "programada")
    .lte("excluir_em", agora.toISOString())
    .order("excluir_em", { ascending: true })
    .limit(limite);
  if (error) {
    logger.error("[exclusao] ler vencidas falhou", { codigo: (error as { code?: string }).code ?? null });
    return null;
  }
  return (data as unknown as ProgramacaoLida[] | null) ?? [];
}

/**
 * Passo 3, uma organização. A guarda do banco é consultada ANTES de qualquer coisa sem volta (Storage e
 * conexões no provedor): organização não programada, cancelada, no prazo, reativada ou sem o aviso de 7 dias
 * volta daqui sem tocar em nada. `forcar` é a exclusão que o admin da plataforma pede à mão.
 */
export async function excluirOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  actorUserId: string | null,
  opcoes: { forcar?: boolean } = {},
): Promise<ResultadoDaExclusao> {
  const forcar = opcoes.forcar === true;
  const { data: veredito, error: erroGuarda } = await admin.rpc("fn_exclusao_pode_executar" as never, {
    p_org: organizationId,
    p_forcar: forcar,
  } as never);
  if (erroGuarda) {
    logger.error("[exclusao] não deu para consultar a guarda", {
      organization_id: organizationId,
      codigo: (erroGuarda as { code?: string }).code ?? null,
    });
    return { ok: false, etapa: "banco", motivo: "guarda_indisponivel" };
  }
  if (veredito !== "ok") {
    return { ok: false, etapa: "guarda", motivo: typeof veredito === "string" ? veredito : "guarda_desconhecida" };
  }

  // O nome, lido ANTES: depois da exclusão não há de onde ler.
  const { data: org } = await admin.from("organizations").select("display_name").eq("id", organizationId).maybeSingle();
  const nome = ((org as { display_name: string | null } | null)?.display_name ?? "").trim() || "Sem nome";

  const arquivos = await apagarArquivosDaOrganizacao(admin, organizationId);
  if (!arquivos.ok) {
    logger.error("[exclusao] arquivos não apagados; a organização fica para a próxima rodada", {
      organization_id: organizationId,
      motivo: arquivos.motivo,
    });
    return { ok: false, etapa: "armazenamento", motivo: arquivos.motivo };
  }
  const conexoes = await encerrarConexoesDaOrganizacao(admin, organizationId);

  const { data, error } = await admin.rpc("fn_exclusao_executar" as never, {
    p_org: organizationId,
    p_actor: actorUserId,
    p_forcar: forcar,
  } as never);
  if (error) {
    const msg = (error as { message?: string }).message ?? "";
    const guarda = /exclusao_(nao_programada|cancelada|ainda_nao_venceu|org_reativada|sem_aviso_de_7_dias|org_inexistente)/.exec(msg);
    if (guarda) return { ok: false, etapa: "guarda", motivo: `exclusao_${guarda[1]}` };
    logger.error("[exclusao] fn_exclusao_executar falhou", {
      organization_id: organizationId,
      codigo: (error as { code?: string }).code ?? null,
    });
    return { ok: false, etapa: "banco", motivo: "banco" };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  const n = (k: string) => Number(r[k] ?? 0);
  const recibo: DadosDoRecibo = {
    nomeDaOrganizacao: nome,
    origem: r.origem === "manual" ? "manual" : "automatica",
    motivo: r.motivo === "suspensa" || r.motivo === "manual" ? r.motivo : "cancelada",
    contatos: n("contatos"),
    conversas: n("conversas"),
    mensagens: n("mensagens"),
    negocios: n("negocios"),
    arquivosApagados: arquivos.apagados,
    conexoesEncerradas: conexoes.encerradas,
    registrosFiscaisArquivados: n("registros_fiscais_arquivados"),
    usuariosRemovidos: n("usuarios_removidos"),
    usuariosMantidos: n("usuarios_mantidos"),
  };
  const recibosEnviados = await enviarReciboDeExclusao(admin, recibo);
  logger.info("[exclusao] organização excluída", {
    organization_id: organizationId,
    arquivos: arquivos.apagados,
    conexoes_encerradas: conexoes.encerradas,
    conexoes_com_falha: conexoes.falhas,
    recibos_enviados: recibosEnviados,
  });
  return {
    ok: true,
    resumo: { ...r, arquivos_apagados: arquivos.apagados, conexoes_encerradas: conexoes.encerradas, conexoes_com_falha: conexoes.falhas },
  };
}

export interface ResumoDaRodada {
  sincronizacaoFalhou: boolean;
  programadas: number;
  atualizadas: number;
  canceladasPorReativacao: number;
  avisosEnfileirados: number;
  vencidas: number;
  excluidas: number;
  falhas: number;
  fiscaisExpurgados: number;
}

export interface OpcoesDaRodada {
  diasDeGuarda: number;
  agora?: Date;
  /** Quanto tempo a rodada pode trabalhar antes de deixar o resto para amanhã. */
  orcamentoMs?: number;
}

export async function rodarExclusaoDeDados(admin: SupabaseClient, opcoes: OpcoesDaRodada): Promise<ResumoDaRodada> {
  const agora = opcoes.agora ?? new Date();
  const inicio = Date.now();
  const orcamento = opcoes.orcamentoMs ?? 120_000;
  const resumo: ResumoDaRodada = {
    sincronizacaoFalhou: false,
    programadas: 0,
    atualizadas: 0,
    canceladasPorReativacao: 0,
    avisosEnfileirados: 0,
    vencidas: 0,
    excluidas: 0,
    falhas: 0,
    fiscaisExpurgados: 0,
  };

  const sinc = await sincronizarProgramacoes(admin, opcoes.diasDeGuarda);
  if (!sinc) resumo.sincronizacaoFalhou = true;
  else {
    resumo.programadas = sinc.programadas;
    resumo.atualizadas = sinc.atualizadas;
    resumo.canceladasPorReativacao = sinc.canceladas_por_reativacao;
  }

  // Sem a sincronização de HOJE as linhas podem estar velhas (um cliente que reativou ainda aparece como
  // programado): a rodada não avisa nem exclui ninguém. Amanhã tenta de novo.
  if (!resumo.sincronizacaoFalhou) {
    resumo.avisosEnfileirados = await enfileirarAvisosDevidos(admin, agora);

    const vencidas = (await organizacoesVencidas(admin, agora)) ?? [];
    resumo.vencidas = vencidas.length;
    for (const v of vencidas) {
      if (Date.now() - inicio > orcamento) break;
      try {
        const r = await excluirOrganizacao(admin, v.organization_id, null);
        if (r.ok) resumo.excluidas++;
        else resumo.falhas++;
      } catch (erro) {
        resumo.falhas++;
        logger.error("[exclusao] exclusão lançou", { organization_id: v.organization_id, motivo: motivoCurto(erro) });
      }
    }
  }

  const { data: expurgo, error: erroExpurgo } = await admin.rpc("fn_exclusao_expurgar_fiscais_vencidos" as never, {
    p_limite: 500,
  } as never);
  if (erroExpurgo) logger.error("[exclusao] expurgo fiscal falhou", { codigo: (erroExpurgo as { code?: string }).code ?? null });
  else resumo.fiscaisExpurgados = Number(expurgo ?? 0);

  return resumo;
}
