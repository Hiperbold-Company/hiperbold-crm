/**
 * O COFRE de chaves secretas das automações (migration 1004, `automacao_segredos`).
 *
 * Uma chave (token de API) por nome, por organização. O bloco "Requisição HTTP"
 * cita a chave pelo id; quem decifra é só o servidor, na hora do envio
 * (`lerValoresDosSegredos`). A tela vê nome e os 4 últimos caracteres.
 *
 * Mesma cifra das outras integrações (`fn_encrypt_oauth`, `lib/webhooks/secrets.ts`).
 *
 * ⚠️ Service role ignora RLS: toda consulta aqui filtra `organization_id`, e quem
 * chama entrega a organização de fonte confiável (sessão, inscrição do banco),
 * nunca do corpo do pedido. ⚠️ O valor nunca vai para log, erro, audit ou resposta.
 *
 * (Não confundir com `chaves.ts`, que são constantes do motor.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { segredosDoBloco, ultimos4, type HttpRequestConfig } from "./http";
import { NOME_DO_SEGREDO } from "./segredos-nome";

export { NOME_DO_SEGREDO };

export const nomeDoSegredoSchema = z
  .string()
  .trim()
  .regex(
    NOME_DO_SEGREDO,
    "Use letras minúsculas, números e underscore, começando por letra (até 40)",
  );

/** A chave em si: sem espaço nem quebra de linha (vai num cabeçalho HTTP), 8 a 4000 caracteres. */
export const valorDoSegredoSchema = z
  .string()
  .min(8, "A chave precisa ter pelo menos 8 caracteres")
  .max(4000)
  .regex(/^[\x21-\x7e]+$/, "A chave não pode ter espaço, acento nem quebra de linha");

export interface SegredoVisivel {
  id: string;
  nome: string;
  ultimos4: string;
  /** Para onde a chave pode ir (migration 1007). `null` = chave antiga, vai para qualquer endereço. */
  hosts_permitidos: string[] | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const COLUNAS_VISIVEIS = "id, nome, ultimos4, hosts_permitidos, created_at, updated_at, last_used_at";

export async function listarSegredos(
  admin: SupabaseClient,
  org: string,
): Promise<SegredoVisivel[]> {
  const { data, error } = await admin
    .from("automacao_segredos")
    .select(COLUNAS_VISIVEIS)
    .eq("organization_id", org)
    .order("nome", { ascending: true });
  if (error) throw new Error("segredos_leitura_falhou");
  return (data ?? []) as SegredoVisivel[];
}

export async function lerSegredoVisivel(
  admin: SupabaseClient,
  org: string,
  id: string,
): Promise<SegredoVisivel | null> {
  const { data, error } = await admin
    .from("automacao_segredos")
    .select(COLUNAS_VISIVEIS)
    .eq("organization_id", org)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("segredos_leitura_falhou");
  return (data as SegredoVisivel | null) ?? null;
}

export type ResultadoDaGravacao =
  | { ok: true; segredo: SegredoVisivel }
  | { ok: false; erro: "cifra_indisponivel" | "nome_em_uso" | "nao_encontrado" | "falha" };

function cifradaParaBytea(hex: string): string {
  return hex.startsWith("\\x") ? hex : `\\x${hex}`;
}

export async function criarSegredo(
  admin: SupabaseClient,
  input: { org: string; nome: string; valor: string; hosts: string[]; atorId: string | null },
): Promise<ResultadoDaGravacao> {
  const cifrada = await encryptWebhookSecret(admin, input.valor);
  if (cifrada === null) return { ok: false, erro: "cifra_indisponivel" };
  const { data, error } = await admin
    .from("automacao_segredos")
    .insert({
      organization_id: input.org,
      nome: input.nome,
      valor_cifrado: cifradaParaBytea(cifrada),
      ultimos4: ultimos4(input.valor),
      hosts_permitidos: input.hosts,
      created_by: input.atorId,
    })
    .select(COLUNAS_VISIVEIS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return { ok: false, erro: "nome_em_uso" };
    logger.warn("[automacoes.segredos] gravação falhou", {
      codigo: (error as { code?: string }).code,
    });
    return { ok: false, erro: "falha" };
  }
  return { ok: true, segredo: data as SegredoVisivel };
}

/**
 * Troca o valor, os endereços permitidos, ou os dois. Quem decide se a troca
 * dos endereços exige o valor junto (`ampliaOsHosts`) é a rota: aqui só grava.
 */
export async function atualizarSegredo(
  admin: SupabaseClient,
  input: { org: string; id: string; valor?: string; hosts?: string[] },
): Promise<ResultadoDaGravacao> {
  const mudanca: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.valor !== undefined) {
    const cifrada = await encryptWebhookSecret(admin, input.valor);
    if (cifrada === null) return { ok: false, erro: "cifra_indisponivel" };
    mudanca.valor_cifrado = cifradaParaBytea(cifrada);
    mudanca.ultimos4 = ultimos4(input.valor);
  }
  if (input.hosts !== undefined) mudanca.hosts_permitidos = input.hosts;
  const { data, error } = await admin
    .from("automacao_segredos")
    .update(mudanca)
    .eq("organization_id", input.org)
    .eq("id", input.id)
    .select(COLUNAS_VISIVEIS)
    .maybeSingle();
  if (error) {
    logger.warn("[automacoes.segredos] troca falhou", {
      codigo: (error as { code?: string }).code,
    });
    return { ok: false, erro: "falha" };
  }
  if (!data) return { ok: false, erro: "nao_encontrado" };
  return { ok: true, segredo: data as SegredoVisivel };
}

export async function apagarSegredo(
  admin: SupabaseClient,
  org: string,
  id: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("automacao_segredos")
    .delete()
    .eq("organization_id", org)
    .eq("id", id)
    .select("id");
  if (error) throw new Error("segredos_remocao_falhou");
  return (data ?? []).length > 0;
}

/** Os ids de chave desta organização (o publish confere que a chave citada existe). */
export async function idsDosSegredos(
  admin: SupabaseClient,
  org: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await admin
    .from("automacao_segredos")
    .select("id")
    .eq("organization_id", org)
    .in("id", [...ids]);
  if (error) throw new Error("segredos_leitura_falhou");
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

/** As chaves que um grafo cita (blocos "Requisição HTTP"). */
export function segredosDoGrafo(grafo: unknown): string[] {
  const nos = (grafo as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nos)) return [];
  const ids = new Set<string>();
  for (const n of nos as Array<{ type?: unknown; config?: unknown }>) {
    if (n?.type !== "http_request") continue;
    const cfg = n.config as { headers?: unknown; body_secrets?: unknown } | undefined;
    const headers = Array.isArray(cfg?.headers)
      ? (cfg.headers as HttpRequestConfig["headers"])
      : [];
    const noCorpo = Array.isArray(cfg?.body_secrets)
      ? (cfg.body_secrets as NonNullable<HttpRequestConfig["body_secrets"]>)
      : [];
    for (const id of segredosDoBloco({ headers, body_secrets: noCorpo })) ids.add(id);
  }
  return [...ids];
}

/** Os NOMES das automações PUBLICADAS (ativas) desta organização que usam a chave. */
export async function automacoesQueUsam(
  admin: SupabaseClient,
  org: string,
  segredoId: string,
): Promise<string[]> {
  const { data: ponteiros, error } = await admin
    .from("followup_flow_pointers")
    .select("id, name, active_version_id")
    .eq("organization_id", org)
    .eq("surface", "automacao")
    .eq("status", "active");
  if (error) throw new Error("segredos_uso_indeterminado");
  const ativos = (
    (ponteiros ?? []) as Array<{ id: string; name: string; active_version_id: string | null }>
  ).filter((p) => p.active_version_id);
  if (ativos.length === 0) return [];
  const { data: versoes, error: erroV } = await admin
    .from("followup_flow_versions")
    .select("id, graph")
    .eq("organization_id", org)
    .in(
      "id",
      ativos.map((p) => p.active_version_id as string),
    );
  if (erroV) throw new Error("segredos_uso_indeterminado");
  const usa = new Set(
    ((versoes ?? []) as Array<{ id: string; graph: unknown }>)
      .filter((v) => segredosDoGrafo(v.graph).includes(segredoId))
      .map((v) => v.id),
  );
  return ativos.filter((p) => usa.has(p.active_version_id as string)).map((p) => p.name);
}

/** O nome e os endereços permitidos de uma chave (o que o motor e o publish conferem). */
export interface DestinoDaChave {
  nome: string;
  hosts_permitidos: string[] | null;
}

/** Nome e endereços permitidos das chaves citadas, SÓ desta organização (o publish confere o host). */
export async function destinosDosSegredos(
  admin: SupabaseClient,
  org: string,
  ids: readonly string[],
): Promise<Map<string, DestinoDaChave>> {
  const mapa = new Map<string, DestinoDaChave>();
  if (ids.length === 0) return mapa;
  const { data, error } = await admin
    .from("automacao_segredos")
    .select("id, nome, hosts_permitidos")
    .eq("organization_id", org)
    .in("id", [...ids]);
  if (error) throw new Error("segredos_leitura_falhou");
  for (const l of (data ?? []) as Array<{ id: string } & DestinoDaChave>)
    mapa.set(l.id, { nome: l.nome, hosts_permitidos: l.hosts_permitidos ?? null });
  return mapa;
}

/**
 * Decifra as chaves citadas, SÓ desta organização. Devolve o mapa id → valor;
 * id ausente do mapa = a chave não existe (apagada) ou não decifrou. Nunca lança.
 * `destinos` traz nome e endereços permitidos de cada chave achada (o motor
 * confere o host ANTES de pôr a chave na requisição).
 */
export async function lerValoresDosSegredos(
  admin: SupabaseClient,
  org: string,
  ids: readonly string[],
): Promise<{
  valores: Map<string, string>;
  destinos: Map<string, DestinoDaChave>;
  inexistentes: string[];
  indisponiveis: string[];
}> {
  const valores = new Map<string, string>();
  const destinos = new Map<string, DestinoDaChave>();
  if (ids.length === 0) return { valores, destinos, inexistentes: [], indisponiveis: [] };
  const { data, error } = await admin
    .from("automacao_segredos")
    .select("id, nome, hosts_permitidos, valor_cifrado")
    .eq("organization_id", org)
    .in("id", [...ids]);
  if (error) return { valores, destinos, inexistentes: [], indisponiveis: [...ids] };
  const indisponiveis: string[] = [];
  for (const linha of (data ?? []) as Array<{
    id: string;
    nome?: string;
    hosts_permitidos?: string[] | null;
    valor_cifrado: string | null;
  }>) {
    destinos.set(linha.id, {
      nome: linha.nome ?? "",
      hosts_permitidos: Array.isArray(linha.hosts_permitidos) ? linha.hosts_permitidos : null,
    });
    const valor = linha.valor_cifrado
      ? await decryptWebhookSecret(admin, linha.valor_cifrado)
      : null;
    if (valor) valores.set(linha.id, valor);
    else indisponiveis.push(linha.id);
  }
  const achados = new Set(((data ?? []) as Array<{ id: string }>).map((l) => l.id));
  return {
    valores,
    destinos,
    inexistentes: ids.filter((id) => !achados.has(id)),
    indisponiveis,
  };
}

/** Marca o uso (a tela mostra "usada pela última vez"). Melhor esforço. */
export async function marcarUsoDosSegredos(
  admin: SupabaseClient,
  org: string,
  ids: readonly string[],
  agora: Date,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await admin
      .from("automacao_segredos")
      .update({ last_used_at: agora.toISOString() })
      .eq("organization_id", org)
      .in("id", [...ids]);
  } catch {
    // Só a marcação: a chamada já saiu.
  }
}
