/**
 * MOVER O MESMO NEGÓCIO PARA UMA ETAPA DE OUTRO FUNIL — a parte decidível.
 *
 * Decisão do dono do produto (14/11/2026): além do clone da P-01
 * (`clonar-para-funil.ts`, que cria um negócio novo e encerra a origem), existe
 * a TROCA de funil do mesmo negócio. Ela é uma operação nomeada, e não o
 * afrouxamento do bloqueio: no banco só `public.fn_mover_negocio_para_outro_funil`
 * (migration 1013) troca `crm_leads.pipeline_id`, e o UPDATE solto segue
 * recusado pelo gatilho `trg_lead_funil_so_pela_troca_nomeada`. Quem fala com o
 * banco é `moverParaOutroFunilHandler` (`app/api/v1/leads/_handler.ts`).
 *
 * Os CAMPOS PERSONALIZADOS: o schema mora no funil (`settings.fields`), e o
 * funil de destino pode não declarar uma chave que o negócio tem preenchida. A
 * troca NÃO apaga valor nenhum: `custom_fields` é jsonb de chave livre (o
 * negócio já aceita chave não declarada), apagar seria irreversível, e voltar o
 * negócio ao funil de origem traz os campos de volta à tela. O que fica fora do
 * schema de destino é LISTADO na atividade da troca, para ninguém ler o sumiço
 * na tela como perda.
 */
import { camposDoFunil } from "@/lib/leads/campos-do-funil";

/** Um valor que conta como preenchido (vazio não é dado a avisar). */
function preenchido(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

/**
 * As chaves de `custom_fields` preenchidas no negócio que o funil de destino não
 * declara em `settings.fields`. Ordem alfabética, para o detalhe ser estável.
 * Os valores continuam gravados: esta lista só avisa.
 */
export function camposForaDoFunilDeDestino(
  customFields: Record<string, unknown> | null | undefined,
  settingsDoDestino: Record<string, unknown> | null | undefined,
): string[] {
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) return [];
  const declaradas = new Set(camposDoFunil(settingsDoDestino).map((c) => c.key));
  return Object.entries(customFields)
    .filter(([chave, valor]) => !declaradas.has(chave) && preenchido(valor))
    .map(([chave]) => chave)
    .sort();
}

/** O texto da timeline: de qual funil/etapa para qual funil/etapa. */
export function motivoDaTrocaDeFunil(
  de: { funil: string | null; etapa: string | null },
  para: { funil: string | null; etapa: string | null },
): string {
  const lado = (x: { funil: string | null; etapa: string | null }) =>
    x.funil && x.etapa ? `${x.funil} › ${x.etapa}` : (x.etapa ?? x.funil ?? "?");
  return `Movido do funil ${lado(de)} para o funil ${lado(para)}`;
}

/** Recusa quando o destino é do MESMO funil: isso é troca de etapa (`moveLeadHandler`). */
export const RECUSA_MESMO_FUNIL =
  "A etapa de destino é do mesmo funil do negócio: use a troca de etapa.";

/** Recusa quando a etapa ou o funil de destino está arquivado. */
export const RECUSA_DESTINO_ARQUIVADO = "A etapa ou o funil de destino está arquivado.";
