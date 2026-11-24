/**
 * Ação "Definir carteira" (`set_carteira`): põe o contato na carteira de um
 * vendedor (`contacts.carteira_user_id`, o dono do cliente).
 *
 * A gravação é SÓ pela porta única `fn_definir_carteira_do_cliente`, a mesma do
 * motor antigo (`lib/automation/actions/assign-owner.ts`, `passarACarteira`):
 * sem ator humano (`p_actor: null`) e com a origem `automacao`, a única que a
 * função aceita sem ator. A função confere o vendedor (membro ativo `agent`,
 * `manager` ou `admin` desta organização) e, na mesma transação, adota os
 * negócios abertos sem dono do contato e passa as conversas abertas do dono
 * anterior (ou sem dono, fora da IA). Nada de UPDATE direto em `contacts`.
 *
 * `se_ja_tiver`:
 *   - `manter`: o contato já está na carteira de OUTRO vendedor → nada é
 *     gravado e o passo conta como concluído (`resultado: "mantido"`, com o
 *     dono atual no detalhe);
 *   - `substituir`: grava sempre.
 * Com o mesmo vendedor já dono, nos dois modos, não há o que gravar
 * (`resultado: "sem_mudanca"`).
 *
 * O dono atual é lido AQUI, do banco, e não dos fatos: fatos montados sem a
 * carteira não podem ser lidos como "sem dono" — `manter` trocaria o dono que
 * devia manter.
 *
 * ⚠️ Service role: a organização vem da INSCRIÇÃO (`c.org`), nunca do grafo, e
 * a leitura do contato filtra `organization_id`. Erro do banco vira código
 * (nunca a mensagem crua no detalhe).
 */
import { audit } from "@/lib/audit";

import type { CrmAction } from "../schemas";
import type { Contexto, Passo } from "./index";

type DefinirCarteira = Extract<CrmAction, { type: "set_carteira" }>;

/** Recusas da função que têm frase própria no histórico; o resto vira `carteira_nao_definida`. */
const RECUSAS_CONHECIDAS = ["carteira_dono_invalido"] as const;

function codigoDaRecusa(mensagem: string | undefined): string {
  const achado = RECUSAS_CONHECIDAS.find((c) => (mensagem ?? "").includes(c));
  return achado ?? "carteira_nao_definida";
}

export async function executarDefinirCarteira(c: Contexto, acao: DefinirCarteira): Promise<Passo> {
  const base = { tipo: acao.type };
  if (!c.contatoId) return { ok: false, erro: "sem_contato", detalhe: base };

  const { data, error } = await c.admin
    .from("contacts")
    .select("id, carteira_user_id")
    .eq("organization_id", c.org)
    .eq("id", c.contatoId)
    .maybeSingle();
  if (error) return { ok: false, erro: "efeito_falhou", detalhe: base };
  if (!data) return { ok: false, erro: "sem_contato", detalhe: base };
  const atual = ((data as { carteira_user_id?: string | null }).carteira_user_id ?? null) || null;

  if (atual === acao.user_id) {
    return { ok: true, detalhe: { ...base, resultado: "sem_mudanca", user_id: acao.user_id } };
  }
  if (atual !== null && acao.se_ja_tiver === "manter") {
    return { ok: true, detalhe: { ...base, resultado: "mantido", dono_atual: atual } };
  }

  const { error: erroDaFuncao } = await c.admin.rpc("fn_definir_carteira_do_cliente", {
    p_org: c.org,
    p_actor: null,
    p_contact: c.contatoId,
    p_dono: acao.user_id,
    p_origem: "automacao",
  });
  if (erroDaFuncao) {
    return { ok: false, erro: codigoDaRecusa(erroDaFuncao.message), detalhe: { ...base, user_id: acao.user_id } };
  }

  // A mesma ação de auditoria da troca pela tela (`contacts/[id]/carteira`), com
  // a automação como ator (o desenho de `create_task`).
  void audit({
    organizationId: c.org,
    actorUserId: null,
    action: "contact.carteira_changed",
    resourceType: "contact",
    resourceId: c.contatoId,
    requestId: c.handler.requestId,
    metadata: {
      actor_type: "webhook_source",
      actor_id: c.pointerId,
      antes: atual,
      depois: acao.user_id,
      origem: "automacao",
      adotados: true,
    },
  });

  return {
    ok: true,
    detalhe: { ...base, resultado: atual === null ? "definido" : "trocado", user_id: acao.user_id },
  };
}
