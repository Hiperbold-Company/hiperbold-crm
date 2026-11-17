/**
 * O RECORTE POR PAPEL dos campos personalizados (migration 1015): quem recebe o campo marcado como
 * não público (`publico: false`) — a DEFINIÇÃO e o VALOR.
 *
 * Regra, de um lugar só:
 *  - administrador da organização recebe tudo;
 *  - gerente, agente, operador de IA e leitor não recebem o campo nem o valor;
 *  - o agente de IA (`"ia"`) e as variáveis de automação (`"automacao"`) NUNCA recebem, nem quando
 *    quem configurou é administrador: o que passa por eles pode sair ao cliente pelo WhatsApp.
 *
 * ⚠️ ISTO NÃO É SIGILO. É o que as telas, a exportação, o agente e a automação entregam. A RLS de
 * `crm_leads`/`contacts` continua deixando o membro ler `custom_fields` inteiro pela REST do
 * Supabase com a própria sessão — por isso o rótulo da tela promete "visível só para
 * administradores nas telas e exportações", nunca "secreto".
 *
 * PURO: sem banco, sem rede. Quem carrega as chaves restritas da organização é
 * `lib/campos/chaves-restritas.ts`.
 */
import { roleAtLeast, type Role } from "@/lib/auth/types";

/** Quem vai ler: um papel do tenant, o agente de IA ou o render de uma automação. */
export type LeitorDosCampos = Role | "ia" | "automacao";

const PAPEIS: readonly string[] = ["viewer", "agent", "ai_operator", "manager", "admin"];

/**
 * O leitor a partir do ATOR que a porta resolveu (o papel viaja no ator — D-148). Agente de IA é
 * `"ia"`; papel ausente ou desconhecido é `null` (não vê o restrito).
 */
export function leitorDoAtor(actor: { type: string; role?: string } | null | undefined): LeitorDosCampos | null {
  if (!actor) return null;
  if (actor.type === "ai_agent") return "ia";
  return actor.role && PAPEIS.includes(actor.role) ? (actor.role as Role) : null;
}

/**
 * O PAPEL para decidir uma gravação (não uma leitura): o do ator quando ele o carrega, senão o piso
 * que a porta acabou de conferir — que é sempre um limite inferior verdadeiro.
 */
export function papelDoAtorOuPiso(actor: { type: string; role?: string } | null | undefined, piso: Role): Role {
  return actor?.role && PAPEIS.includes(actor.role) ? (actor.role as Role) : piso;
}

/** Só administrador recebe campo não público. Máquina nunca; papel ausente também não. */
export function leitorVeCamposRestritos(leitor: LeitorDosCampos | null | undefined): boolean {
  if (!leitor || leitor === "ia" || leitor === "automacao") return false;
  return roleAtLeast(leitor, "admin");
}

/** O item de `settings.fields` (ou a definição) é não público? Ausência é público. */
export function campoEhRestrito(campo: unknown): boolean {
  return !!campo && typeof campo === "object" && (campo as { publico?: unknown }).publico === false;
}

/** As chaves (em minúsculas) dos campos não públicos de uma lista de campos. Lixo é ignorado. */
export function chavesRestritasDosCampos(campos: unknown): Set<string> {
  const saida = new Set<string>();
  if (!Array.isArray(campos)) return saida;
  for (const campo of campos) {
    const chave = (campo as { key?: unknown } | null)?.key;
    if (campoEhRestrito(campo) && typeof chave === "string") saida.add(chave.toLowerCase());
  }
  return saida;
}

/** Junta conjuntos de chaves restritas (as da organização com as do funil lido, por exemplo). */
export function unirChavesRestritas(...conjuntos: Array<ReadonlySet<string> | null | undefined>): Set<string> {
  const saida = new Set<string>();
  for (const c of conjuntos) for (const k of c ?? []) saida.add(k.toLowerCase());
  return saida;
}

/** A lista de campos que este leitor recebe. */
export function recortarCampos<T>(campos: readonly T[], leitor: LeitorDosCampos | null | undefined): T[] {
  if (leitorVeCamposRestritos(leitor)) return [...campos];
  return campos.filter((c) => !campoEhRestrito(c));
}

/**
 * A chave de campo NORMALIZADA: sem acento, minúscula, pontuação e espaço viram `_`, sem `_` nas
 * pontas ("Company Name" → `company_name`, "Cargo / Posição" → `cargo_posicao`). É a MESMA regra
 * com que os leitores tolerantes (`cargoEEmpresa`) acham o valor; o recorte a usa também, senão
 * um valor gravado como "Company Name" escaparia da chave restrita `company_name` e seria lido.
 */
export function normalizarChaveDeCampo(chave: string): string {
  return chave
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * O predicado ÚNICO de "esta chave é restrita": casa sem diferenciar maiúsculas (a regra de sempre)
 * OU pela forma normalizada. Todo ponto que decide recorte, filtro, exportação ou preservação usa
 * este, senão um lugar corta "Company Name" e outro não.
 */
export function chaveEhRestrita(restritas: ReadonlySet<string>): (chave: string) => boolean {
  if (restritas.size === 0) return () => false;
  const normalizadas = new Set([...restritas].map(normalizarChaveDeCampo));
  return (k: string) => restritas.has(k.toLowerCase()) || normalizadas.has(normalizarChaveDeCampo(k));
}

/**
 * Os valores (`custom_fields`) que este leitor recebe: sem as chaves restritas. Uma chave sai se
 * casa uma restrita sem diferenciar maiúsculas (a regra de sempre) OU pela forma normalizada
 * (`normalizarChaveDeCampo`) — só acrescenta casos, nunca deixa passar o que antes saía.
 * Não é objeto → volta como veio. Nada a tirar → o MESMO objeto.
 */
export function recortarValores<T>(
  valores: T,
  restritas: ReadonlySet<string>,
  leitor: LeitorDosCampos | null | undefined,
): T {
  if (leitorVeCamposRestritos(leitor) || restritas.size === 0) return valores;
  if (!valores || typeof valores !== "object" || Array.isArray(valores)) return valores;
  const entrada = valores as Record<string, unknown>;
  const restrita = chaveEhRestrita(restritas);
  if (!Object.keys(entrada).some(restrita)) return valores;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entrada)) if (!restrita(k)) saida[k] = v;
  return saida as T;
}

/** O `settings` de um funil com `fields` recortado para o leitor (o resto de `settings` intacto). */
export function recortarSettingsDoFunil<T>(settings: T, leitor: LeitorDosCampos | null | undefined): T {
  if (leitorVeCamposRestritos(leitor)) return settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  const fields = (settings as { fields?: unknown }).fields;
  if (!Array.isArray(fields) || !fields.some(campoEhRestrito)) return settings;
  return { ...(settings as Record<string, unknown>), fields: recortarCampos(fields, leitor) } as T;
}

/**
 * Uma linha com `custom_fields` (negócio ou contato), recortada. Devolve a mesma linha quando não há
 * o que tirar.
 */
export function recortarLinha<T>(linha: T, restritas: ReadonlySet<string>, leitor: LeitorDosCampos | null | undefined): T {
  if (!linha || typeof linha !== "object") return linha;
  const atual = (linha as { custom_fields?: unknown }).custom_fields;
  const recortado = recortarValores(atual, restritas, leitor);
  return recortado === atual ? linha : ({ ...(linha as Record<string, unknown>), custom_fields: recortado } as T);
}

/**
 * A GRAVAÇÃO que SUBSTITUI `custom_fields` inteiro (o PATCH do contato) não pode apagar o valor que
 * quem gravou nem recebeu: chave restrita AUSENTE na entrada mantém o valor que já estava gravado.
 * Chave restrita PRESENTE na entrada vale como veio (é o administrador limpando ou trocando).
 */
export function preservarValoresRestritos(
  entrada: Record<string, unknown>,
  existente: unknown,
  restritas: ReadonlySet<string>,
): Record<string, unknown> {
  if (restritas.size === 0 || !existente || typeof existente !== "object" || Array.isArray(existente)) return entrada;
  const restrita = chaveEhRestrita(restritas);
  // "Presente" segue a mesma tolerância do recorte: a entrada trazer "company_name" conta como
  // trazer "Company Name". Senão o valor que o leitor nem recebeu seria apagado ao salvar.
  const presentes = new Set(Object.keys(entrada).flatMap((k) => [k.toLowerCase(), normalizarChaveDeCampo(k)]));
  let saida: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(existente as Record<string, unknown>)) {
    if (!restrita(k) || presentes.has(k.toLowerCase()) || presentes.has(normalizarChaveDeCampo(k))) continue;
    saida ??= { ...entrada };
    saida[k] = v;
  }
  return saida ?? entrada;
}
