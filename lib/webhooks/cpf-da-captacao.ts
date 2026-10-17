/**
 * O CPF que chega pelo formulário de captação (campo reservado `cpf`), gravado
 * no CONTATO — nunca no lead, no histórico de captação nem em campo
 * personalizado (decisão do dono do produto, 17/10/2026).
 *
 * Mesmo esquema do resto do produto para a coluna: `cpf_hash` (sha256 do CPF só
 * com dígitos, `hashCpf`) + `cpf_encrypted` (`cifrarCpfDaInstalacao`), gravados
 * JUNTOS por causa da constraint `contacts_cpf_consistency`.
 *
 * Regras, todas de falha ABERTA (a captação do lead nunca cai por causa do CPF):
 *   - contato que já tem CPF não é sobrescrito;
 *   - outro contato ativo da organização com o mesmo `cpf_hash` (índice único
 *     parcial `uniq_contacts_org_cpf`): o CPF é pulado e a captação segue;
 *   - contato anonimizado (LGPD) não recebe dado novo;
 *   - sem chave de cifra na instalação: não grava (jamais em claro).
 *
 * O texto do CPF não entra em log, em erro nem em retorno: só o desfecho.
 * Toda consulta carrega `organization_id`, resolvido da FONTE (admin ignora RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { cifrarCpfDaInstalacao, hashCpf } from "@/lib/contacts/cpf";
import { logger } from "@/lib/logger";

export type DesfechoDoCpf =
  | "gravado"
  | "ja_tinha"
  | "duplicado"
  | "anonimizado"
  | "sem_chave_de_cifra"
  | "contato_nao_encontrado"
  | "erro";

export async function gravarCpfDoContato(
  admin: SupabaseClient,
  alvo: { organizationId: string; contactId: string; cpf: string },
): Promise<DesfechoDoCpf> {
  const contexto = { organizationId: alvo.organizationId, contactId: alvo.contactId };
  const registrar = (desfecho: DesfechoDoCpf, extra: Record<string, unknown> = {}): DesfechoDoCpf => {
    if (desfecho !== "gravado" && desfecho !== "ja_tinha") {
      logger.warn("[webhooks.inbound] cpf do envio não foi gravado", { ...contexto, desfecho, ...extra });
    }
    return desfecho;
  };

  try {
    const { data: contato, error: eContato } = await admin
      .from("contacts")
      .select("id, cpf_hash, is_anonymized")
      .eq("organization_id", alvo.organizationId)
      .eq("id", alvo.contactId)
      .maybeSingle();
    if (eContato) return registrar("erro", { errorCode: eContato.code });
    if (!contato) return registrar("contato_nao_encontrado");
    if (contato.is_anonymized === true) return registrar("anonimizado");
    if (contato.cpf_hash) return "ja_tinha";

    const hash = hashCpf(alvo.cpf);
    const { data: outro, error: eOutro } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", alvo.organizationId)
      .eq("cpf_hash", hash)
      .is("is_merged_into", null)
      .neq("id", alvo.contactId)
      .limit(1);
    if (eOutro) return registrar("erro", { errorCode: eOutro.code });
    if (outro && outro.length > 0) return registrar("duplicado");

    const cifrado = await cifrarCpfDaInstalacao(admin, alvo.cpf);
    if (!cifrado) return registrar("sem_chave_de_cifra");

    const { error: eGravar } = await admin
      .from("contacts")
      .update({ cpf_hash: hash, cpf_encrypted: cifrado })
      .eq("organization_id", alvo.organizationId)
      .eq("id", alvo.contactId)
      .is("cpf_hash", null);
    if (eGravar) {
      // Corrida com outro envio com o mesmo CPF: a trava única decidiu.
      return registrar(eGravar.code === "23505" ? "duplicado" : "erro", { errorCode: eGravar.code });
    }
    return "gravado";
  } catch (err) {
    return registrar("erro", { errorName: err instanceof Error ? err.name : "desconhecido" });
  }
}
