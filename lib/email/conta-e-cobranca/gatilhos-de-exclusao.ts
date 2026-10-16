/**
 * O aviso de exclusão dos dados (COB-12, migration 0959): enfileira o e-mail D-30 / D-7 aos administradores da
 * organização, com cópia ao operador. A chave é a DATA da exclusão mais o marco (`exclusao:aaaa-mm-dd:d30`), então
 * rodar a rodada duas vezes no mesmo dia, ou reprogramar para a mesma data, não duplica: a fila é idempotente por
 * (organização, e-mail, chave). Reprogramar para outra data é outro fato e avisa de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { enfileirarEmailDeConta, type DesfechoDoEnfileiramento, type Enfileirador } from "./fila";

export interface AvisoDeExclusao {
  organizationId: string;
  chave: string;
  /** Dia civil `aaaa-mm-dd`. */
  excluirEm: string;
  dias: 30 | 7;
  motivo: "cancelada" | "suspensa" | "manual";
}

export function criarEnfileiradorDeAvisoDeExclusao(
  admin: SupabaseClient,
  enfileirar: Enfileirador = (entrada) => enfileirarEmailDeConta(entrada, admin),
): (aviso: AvisoDeExclusao) => Promise<DesfechoDoEnfileiramento> {
  return (aviso) =>
    enfileirar({
      organizationId: aviso.organizationId,
      emailId: "COB-12",
      chave: aviso.chave,
      destino: "admins",
      copiaParaOperador: true,
      dados: { excluirEm: aviso.excluirEm, dias: aviso.dias, motivo: aviso.motivo },
    });
}
