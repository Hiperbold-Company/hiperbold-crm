/**
 * Os tetos de agentes de IA e de automações do plano (D-227, migration 1002).
 *
 * Os dois bloqueiam SEMPRE, qualquer que seja `billing_settings.modo`, como Conexões (`fn_billing_bloqueia`
 * da 1002). Quem decide de verdade é o banco (`trg_billing_trava_ai_agents` e
 * `trg_billing_trava_followup_flow_pointers`, PT402 com `detail` = o item). Este módulo é a frase e o estado
 * do botão, para a tela dizer o motivo antes de a pessoa tentar.
 *
 * Leitura que falha LIBERA (nunca desabilita por acidente) e grita `alarme_planos_leitura`, igual `podeCriar`:
 * a trava do banco continua valendo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { BloqueioDoBotao } from "./estado-do-bloqueio";
import { limiteDe } from "./plano-da-organizacao";
import { podeCriar } from "./pode-criar";

export type ItemDeTetoDeCriacao = "agentes_ia" | "automacoes";

const FRASE_NO_PLURAL: Record<ItemDeTetoDeCriacao, string> = {
  agentes_ia: "Seu plano permite até {n} agentes de IA.",
  automacoes: "Seu plano permite até {n} automações.",
};

const FRASE_NO_SINGULAR: Record<ItemDeTetoDeCriacao, string> = {
  agentes_ia: "Seu plano permite até 1 agente de IA.",
  automacoes: "Seu plano permite até 1 automação.",
};

const FRASE_SEM_NUMERO: Record<ItemDeTetoDeCriacao, string> = {
  agentes_ia: "Seu plano chegou ao limite de agentes de IA. Mude de plano para criar mais.",
  automacoes: "Seu plano chegou ao limite de automações. Mude de plano para criar mais.",
};

/** A frase do teto. Sem o número (leitura falhou) cai na frase sem número, que continua verdadeira. */
export function fraseDoTetoDeCriacao(
  item: ItemDeTetoDeCriacao,
  limite: number | null,
  idioma: Idioma = "pt-BR",
): string {
  if (limite === null) return traduzir(FRASE_SEM_NUMERO[item], idioma);
  if (limite === 1) return traduzir(FRASE_NO_SINGULAR[item], idioma);
  return traduzir(FRASE_NO_PLURAL[item], idioma).replaceAll("{n}", String(limite));
}

/** A frase com o limite efetivo da organização. Nunca lança. */
export async function mensagemDoTetoDeCriacao(
  admin: SupabaseClient,
  organizationId: string,
  item: ItemDeTetoDeCriacao,
  idioma: Idioma = "pt-BR",
  log?: Logger,
): Promise<string> {
  const r = await limiteDe(admin, organizationId, item, log);
  return fraseDoTetoDeCriacao(item, r.leituraFalhou ? null : r.valor, idioma);
}

/** O botão de criar: desabilitado só quando o banco disse que o teto está cheio. */
export async function bloqueioDoBotaoDeCriacao(
  admin: SupabaseClient,
  organizationId: string,
  item: ItemDeTetoDeCriacao,
  idioma: Idioma = "pt-BR",
  log?: Logger,
): Promise<BloqueioDoBotao> {
  const veredito = await podeCriar(admin, organizationId, item, undefined, log);
  if (veredito.leituraFalhou || veredito.pode || veredito.motivo !== "teto_atingido") {
    return { desabilitado: false, motivo: null, suspensa: false };
  }
  return { desabilitado: true, motivo: fraseDoTetoDeCriacao(item, veredito.teto, idioma), suspensa: false };
}
