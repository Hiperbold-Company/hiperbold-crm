/**
 * A RÉGUA dos motivos de perda da organização (migration 1021) — sem `next/headers`, sem audit e
 * sem client próprio (a leitura recebe o client de quem chama), para caber no navegador (a janela de perder e o filtro do quadro a importam). O porquê inteiro está em
 * `lib/leads/motivos-da-organizacao.ts`, que é a porta do servidor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

/** A chave do settings EFETIVO que carrega a lista legada do funil (só aceitação). */
export const MOTIVOS_LEGADOS_DO_FUNIL = "lost_reasons_do_funil";

/** O teto da lista da organização (o mesmo do funil e do banco). */
export const LIMITE_DE_MOTIVOS = 50;

/** A régua de gravação: a mesma do funil, que a lista da organização herda. */
export const motivosDaOrganizacaoSchema = pipelineConfigPatchSchema.shape.lost_reasons.unwrap();

export type MotivoDePerdaGravado = string | { label: string; categoria?: string };

/** A lista da organização como está em `organizations.settings`; `null` = a organização não tem a chave. */
export function listaDaOrganizacao(settingsDaOrganizacao: unknown): unknown[] | null {
  if (!settingsDaOrganizacao || typeof settingsDaOrganizacao !== "object" || Array.isArray(settingsDaOrganizacao)) {
    return null;
  }
  const bruto = (settingsDaOrganizacao as { lost_reasons?: unknown }).lost_reasons;
  return Array.isArray(bruto) ? bruto : null;
}

/**
 * O settings EFETIVO de um funil: `lost_reasons` passa a ser a lista da organização e a do funil vai
 * para `lost_reasons_do_funil`. `motivosDaOrganizacao = null` (sem a chave, ou leitura que falhou)
 * devolve o settings como veio.
 */
export function settingsComMotivosDaOrganizacao<T>(settingsDoFunil: T, motivosDaOrganizacao: unknown[] | null): T {
  if (motivosDaOrganizacao === null) return settingsDoFunil;
  const base =
    settingsDoFunil && typeof settingsDoFunil === "object" && !Array.isArray(settingsDoFunil)
      ? (settingsDoFunil as Record<string, unknown>)
      : {};
  const legado = Array.isArray(base.lost_reasons) ? base.lost_reasons : [];
  return { ...base, lost_reasons: motivosDaOrganizacao, [MOTIVOS_LEGADOS_DO_FUNIL]: legado } as T;
}

/** O rótulo comparável: sem diferença de maiúsculas e espaços — a mesma régua da fusão da 1021. */
export function motivoNormalizado(rotulo: string): string {
  return rotulo.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

function rotuloDoItem(item: unknown): string | null {
  const bruto = typeof item === "string" ? item : (item as { label?: unknown } | null)?.label;
  return typeof bruto === "string" && bruto.trim() ? bruto : null;
}

/** Os rótulos de uma lista crua (texto ou `{label}`), como gravados. */
export function rotulosDaLista(lista: unknown): string[] {
  if (!Array.isArray(lista)) return [];
  return lista.map(rotuloDoItem).filter((r): r is string => r !== null);
}

/**
 * Lista limpa para gravar como a lista da organização: apara rótulo e categoria, tira repetição pela
 * régua normalizada (o primeiro fica) e mantém a ordem. Quem valida o formato é o Zod antes.
 */
export function listaLimpa(lista: readonly MotivoDePerdaGravado[]): MotivoDePerdaGravado[] {
  const vistos = new Set<string>();
  const out: MotivoDePerdaGravado[] = [];
  for (const item of lista) {
    const rotulo = (typeof item === "string" ? item : item.label).trim();
    if (!rotulo) continue;
    const chave = motivoNormalizado(rotulo);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const categoria = typeof item === "string" ? undefined : item.categoria?.trim() || undefined;
    out.push(categoria ? { label: rotulo, categoria } : rotulo);
  }
  return out;
}

/** As duas listas são a mesma (ordem, rótulo e categoria)? É o que decide se há audit. */
export function mesmaLista(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}


/** Lista crua → rótulos (na ordem) e rótulo → categoria. É o que a tela de edição desenha. */
export function rotulosECategorias(lista: unknown): { rotulos: string[]; categorias: Record<string, string> } {
  const rotulos: string[] = [];
  const categorias: Record<string, string> = {};
  if (!Array.isArray(lista)) return { rotulos, categorias };
  for (const item of lista) {
    const rotulo = rotuloDoItem(item);
    if (!rotulo) continue;
    rotulos.push(rotulo.trim());
    const categoria = typeof item === "object" && item ? (item as { categoria?: unknown }).categoria : undefined;
    if (typeof categoria === "string" && categoria.trim()) categorias[rotulo.trim()] = categoria.trim();
  }
  return { rotulos, categorias };
}

/** O texto da caixa (separado por vírgula) + as categorias escolhidas → a lista para gravar. */
export function listaDoTexto(texto: string, categorias: Readonly<Record<string, string>>): MotivoDePerdaGravado[] {
  const itens = texto
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((rotulo): MotivoDePerdaGravado => (categorias[rotulo] ? { label: rotulo, categoria: categorias[rotulo] } : rotulo));
  return listaLimpa(itens);
}

/**
 * Lê a lista da organização. FAIL-OPEN: falha de leitura (sessão sem segundo fator que a RLS barra,
 * rede, dublê de teste que não serve a tabela) devolve `null`, e quem chama cai no legado do funil —
 * a mesma degradação de `settingsDoFunil`. O banco continua sendo a régua final.
 */
export async function lerMotivosDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string | null | undefined,
): Promise<unknown[] | null> {
  if (!organizationId) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error || !data) return null;
    return listaDaOrganizacao((data as { settings?: unknown }).settings);
  } catch {
    return null;
  }
}

