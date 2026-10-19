/**
 * Exclusão de contatos em lote — A MESMA exclusão da lixeira de uma linha
 * (`deleteContactHandler`, `app/api/v1/contacts/_handler.ts`), em blocos.
 *
 * Semântica da lixeira, de propósito (não existe "outra forma de apagar"):
 *  1. contato com vínculo RESTRICT que a exclusão não apaga (`VINCULOS_RESTRICT_NAO_APAGADOS`,
 *     hoje a agenda) NÃO é apagado e volta como "bloqueado", com o histórico intacto;
 *  2. apaga as mensagens, as conversas e a ficha. Os negócios (`crm_leads.contact_id`) ficam,
 *     sem contato (`ON DELETE SET NULL`);
 *  3. emite `contact.deleted` por contato apagado (quem assina webhook de saída recebe o mesmo
 *     evento da lixeira).
 * É apagamento DEFINITIVO (não anonimiza, não tem lixeira): quem quer preservar histórico
 * anonimiza pela ficha (LGPD).
 *
 * O que o lote tem a mais que a lixeira, e por quê:
 *  - TUDO-OU-NADA POR BLOCO. As três exclusões de um bloco rodam numa função do banco
 *    (`fn_excluir_contatos_em_lote`, migration 0971), numa única transação: se qualquer passo é
 *    recusado, o bloco volta inteiro e nenhum contato fica com o histórico apagado e a ficha de
 *    pé. A lixeira de uma linha faz três comandos soltos; num lote isso deixaria contato meio
 *    apagado.
 *  - Blocos de 20: travas curtas e cada chamada bem abaixo do `statement_timeout` (apagar
 *    mensagens é o passo caro). Falha num bloco PARA o lote: os anteriores ficam apagados (cada
 *    um completo), o do erro e os seguintes não foram tocados.
 *  - Só contato VIVO: anonimizado e lápide de fusão ficam de fora e voltam em `ignorados`.
 *
 * Todo acesso filtra `organization_id`. O cliente é o da sessão (RLS vale): a função é
 * SECURITY INVOKER e confere o piso `manager` por dentro.
 *
 * Reenvio é seguro: o que já foi apagado não existe mais e é contado em `inexistentes`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { VINCULOS_RESTRICT_NAO_APAGADOS } from "@/lib/contacts/vinculos-restrict";

/** Contatos por bloco: o teto da função do banco é 100, e 20 mantém cada transação curta. */
export const TAMANHO_DO_BLOCO_DE_EXCLUSAO = 20;
/** Quantos `emit_event` em voo ao mesmo tempo. */
const EVENTOS_EM_PARALELO = 10;

export interface ResultadoDaExclusaoEmLote {
  /** Ids realmente apagados. */
  excluidos: string[];
  /** Contatos que NÃO foram apagados por terem registro vinculado (ex.: compromisso na agenda). */
  bloqueados: string[];
  /** Anonimizados e lápides de fusão: o lote só opera contato vivo. */
  ignorados: number;
  /** Pedidos que já não existiam. */
  inexistentes: number;
  /** O banco recusou um bloco: o que vem depois dele NÃO foi tentado. */
  interrompido: boolean;
  /** Ids do bloco recusado. A função é tudo-ou-nada: NADA deste bloco foi apagado. */
  falhou: string[];
}

export interface OpcoesDaExclusaoEmLote {
  organizationId: string;
  requestId: string;
  /** Metadados do ator que vão no `emit_event` (mesmo formato da lixeira de uma linha). */
  metadataDoAtor: Record<string, unknown>;
}

function blocos<T>(lista: T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) saida.push(lista.slice(i, i + tamanho));
  return saida;
}

export async function excluirContatosEmLote(
  supabase: SupabaseClient,
  idsPedidos: string[],
  { organizationId, requestId, metadataDoAtor }: OpcoesDaExclusaoEmLote,
): Promise<ResultadoDaExclusaoEmLote> {
  const ids = [...new Set(idsPedidos)];
  const resultado: ResultadoDaExclusaoEmLote = {
    excluidos: [],
    bloqueados: [],
    ignorados: 0,
    inexistentes: 0,
    interrompido: false,
    falhou: [],
  };

  for (const bloco of blocos(ids, TAMANHO_DO_BLOCO_DE_EXCLUSAO)) {
    const { data: existentes, error: erroExistentes } = await supabase
      .from("contacts")
      .select("id, is_anonymized, is_merged_into")
      .eq("organization_id", organizationId)
      .in("id", bloco);
    if (erroExistentes) {
      resultado.interrompido = true;
      resultado.falhou.push(...bloco);
      return resultado;
    }
    const linhas = (existentes ?? []) as Array<{
      id: string;
      is_anonymized: boolean | null;
      is_merged_into: string | null;
    }>;
    resultado.inexistentes += bloco.length - linhas.length;
    const vivos = linhas.filter((c) => !c.is_anonymized && !c.is_merged_into).map((c) => c.id);
    resultado.ignorados += linhas.length - vivos.length;
    if (vivos.length === 0) continue;

    // Vínculos que barram o DELETE da ficha: conferidos ANTES de qualquer exclusão. A função do
    // banco confere de novo por dentro (defesa em profundidade); aqui é para CLASSIFICAR o que
    // voltou como bloqueado. Falha da checagem não autoriza seguir.
    const barrados = new Set<string>();
    for (const vinculo of VINCULOS_RESTRICT_NAO_APAGADOS) {
      const { data, error } = await supabase
        .from(vinculo.tabela)
        .select("contact_id")
        .eq("organization_id", organizationId)
        .in("contact_id", vivos);
      if (error) {
        resultado.interrompido = true;
        resultado.falhou.push(...vivos);
        return resultado;
      }
      for (const linha of (data ?? []) as Array<{ contact_id: string }>) barrados.add(linha.contact_id);
    }
    const apagaveis = vivos.filter((id) => !barrados.has(id));
    resultado.bloqueados.push(...vivos.filter((id) => barrados.has(id)));
    if (apagaveis.length === 0) continue;

    const { data: apagados, error: erroDoBloco } = await supabase.rpc("fn_excluir_contatos_em_lote", {
      p_organization_id: organizationId,
      p_contact_ids: apagaveis,
    });
    if (erroDoBloco) {
      resultado.interrompido = true;
      resultado.falhou.push(...apagaveis);
      return resultado;
    }

    const idsApagados = (Array.isArray(apagados) ? apagados : []) as string[];
    resultado.excluidos.push(...idsApagados);
    // Sumiu entre a conferência e a função (outra pessoa apagou), ou passou a ter compromisso.
    resultado.inexistentes += apagaveis.length - idsApagados.length;

    for (const lote of blocos(idsApagados, EVENTOS_EM_PARALELO)) {
      await Promise.all(
        lote.map((id) =>
          supabase
            .rpc("emit_event", {
              p_event_type: "contact.deleted",
              p_entity_kind: "contact",
              p_entity_id: id,
              p_payload: {},
              p_metadata: { request_id: requestId, ...metadataDoAtor },
              p_organization_id: organizationId,
            })
            .then(({ error }) => {
              if (error) logger.error("contacts.bulk_delete.emit_event_failed", { mensagem: error.message });
            }),
        ),
      );
    }
  }
  return resultado;
}
