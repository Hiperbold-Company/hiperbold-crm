/**
 * Hiperbold: a exclusão manual de uma organização respeita a RÉGUA DE COBRANÇA própria.
 *
 * Decisão do dono do produto (04/11/2026): "só é excluída dentro das regras que definimos: primeiro a conta é
 * suspensa, temos os e-mails de lembrete, temos o período definido, e se após tudo isso o cliente continuar
 * inadimplente, sim será excluída." A régua é a de `lib/billing/assinatura/conferir-vencimentos.ts`
 * (`ativa` → `atrasada` → `suspensa`), e quem exclui no fim dela é a rodada programada de
 * `lib/retencao/exclusao-de-organizacao/` — não o botão do admin.
 *
 * Por isso, enquanto o contrato (`billing_contracts`) estiver `atrasada` ou `suspensa`, a exclusão MANUAL
 * (rota `/api/v1/admin/tenants/[id]/delete`, ação "Excluir agora") é recusada. Fica liberada quando:
 *  - não há contrato (organização de teste, acesso concedido pelo admin);
 *  - o contrato está `avaliacao` ou `ativa` (não há inadimplência: ex. suspensa pelo admin por outro motivo);
 *  - o contrato está `cancelada` (a régua terminou);
 *  - o contrato é "sem plano" (`contratoSemPlano`: nasce `suspensa` sem período e sem ciclo, cadastro que
 *    nunca pagou, migração 0940). Não há dívida nem régua correndo: a suspensão é o estado inicial.
 *
 * A leitura é a MESMA da tela de assinatura (`estadoDaAssinatura`). Leitura que falha RECUSA: a exclusão é
 * irreversível, e decidir sem saber poderia apagar uma empresa que está no meio da régua.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { estadoDaAssinatura } from "@/lib/billing/assinatura/estado-da-assinatura";
import { contratoSemPlano } from "@/lib/billing/assinatura/sem-plano";

/** Estados do contrato em que a régua de inadimplência ainda está correndo. */
export const ESTADOS_NA_REGUA = ["atrasada", "suspensa"] as const;

export const MENSAGEM_NA_REGUA =
  "Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.";

export const MENSAGEM_COBRANCA_ILEGIVEL =
  "Não foi possível conferir a cobrança desta empresa agora. Nada foi apagado; tente de novo.";

export type ReguaDaExclusao =
  | { liberada: true }
  | {
      liberada: false;
      codigo: "exclusao_na_regua_de_cobranca" | "cobranca_ilegivel";
      mensagem: string;
      /** O estado do contrato que segurou a exclusão (`null` quando a leitura falhou). */
      estado: string | null;
    };

/** Nunca lança: erro de leitura vira `cobranca_ilegivel` (recusa). */
export async function reguaDaCobrancaPermiteExcluir(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ReguaDaExclusao> {
  let leitura: Awaited<ReturnType<typeof estadoDaAssinatura>>;
  try {
    leitura = await estadoDaAssinatura(admin, organizationId);
  } catch {
    leitura = { contrato: null, modoLeituraValendo: false, leituraFalhou: true };
  }
  if (leitura.leituraFalhou) {
    return { liberada: false, codigo: "cobranca_ilegivel", mensagem: MENSAGEM_COBRANCA_ILEGIVEL, estado: null };
  }
  const contrato = leitura.contrato;
  const estado = contrato?.status ?? null;
  if (contrato && contratoSemPlano(contrato)) return { liberada: true };
  if (estado !== null && (ESTADOS_NA_REGUA as readonly string[]).includes(estado)) {
    return { liberada: false, codigo: "exclusao_na_regua_de_cobranca", mensagem: MENSAGEM_NA_REGUA, estado };
  }
  return { liberada: true };
}
