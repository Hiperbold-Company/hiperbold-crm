import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Uma CHAVE SECRETA das automações, gerente+.
 *
 *   PATCH  — troca o valor `{ valor }`, os endereços permitidos `{ hosts_permitidos }`, ou os
 *            dois (o nome não muda: é por ele que a tela a lista). INCLUIR um endereço que a
 *            lista não tinha exige o valor junto (422 `segredo_valor_exigido`): quem edita
 *            automação também edita a chave, e sem isso acrescentaria o próprio servidor e
 *            mandaria a chave para lá sem conhecê-la. Tirar endereço, ou preencher a lista de
 *            uma chave antiga (que ia para qualquer endereço), só restringe e não pede o valor.
 *   DELETE — apaga. Chave usada por automação PUBLICADA é recusada (409) com o
 *            nome das automações: apagar faria o bloco "Requisição HTTP" sair por
 *            "Falhou" em toda execução, em silêncio.
 *
 * O valor nunca volta na resposta nem no audit.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ampliaOsHosts, hostsPermitidosSchema } from "@/lib/automacoes/hosts-permitidos";
import {
  apagarSegredo,
  atualizarSegredo,
  automacoesQueUsam,
  lerSegredoVisivel,
  valorDoSegredoSchema,
} from "@/lib/automacoes/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

import { portaDoCofre, UUID_RX } from "../_porta";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const patchSchema = z
  .strictObject({
    valor: valorDoSegredoSchema.optional(),
    hosts_permitidos: hostsPermitidosSchema.optional(),
  })
  .refine((c) => c.valor !== undefined || c.hosts_permitidos !== undefined);

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const p = await portaDoCofre(req, true);
  if (p.resposta) return p.resposta;
  const { org, requestId, t } = p;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId });

  const bruto: unknown = await req.json().catch(() => null);
  const hostsBrutos = (bruto as { hosts_permitidos?: unknown } | null)?.hosts_permitidos;
  if (hostsBrutos !== undefined && !hostsPermitidosSchema.safeParse(hostsBrutos).success) {
    return fail(
      "validation_failed",
      t(
        "Informe pelo menos um endereço permitido (até 10), só o nome do servidor, como api.exemplo.com.br: sem https://, sem caminho e sem porta.",
      ),
      400,
      { requestId },
    );
  }
  const corpo = patchSchema.safeParse(bruto);
  if (!corpo.success) {
    return fail(
      "validation_failed",
      t("Cole a chave inteira, sem espaços (mínimo de 8 caracteres)."),
      400,
      { requestId },
    );
  }
  const admin = createAdminClient();
  const novosHosts = corpo.data.hosts_permitidos;
  let hostsAntes: string[] | null = null;
  if (novosHosts !== undefined) {
    let atual;
    try {
      atual = await lerSegredoVisivel(admin, org, id);
    } catch {
      return fail("internal_error", t("Não consegui gravar a chave."), 500, { requestId });
    }
    if (!atual) return fail("not_found", t("Chave não encontrada."), 404, { requestId });
    hostsAntes = atual.hosts_permitidos;
    if (corpo.data.valor === undefined && ampliaOsHosts(hostsAntes, novosHosts)) {
      return fail(
        "segredo_valor_exigido",
        t(
          "Para incluir um endereço novo, cole a chave de novo. Assim ninguém manda a chave para outro servidor sem conhecê-la.",
        ),
        422,
        { requestId },
      );
    }
  }
  const r = await atualizarSegredo(admin, {
    org,
    id,
    ...(corpo.data.valor !== undefined ? { valor: corpo.data.valor } : {}),
    ...(novosHosts !== undefined ? { hosts: novosHosts } : {}),
  });
  if (!r.ok) {
    if (r.erro === "nao_encontrado")
      return fail("not_found", t("Chave não encontrada."), 404, { requestId });
    return fail(
      "internal_error",
      r.erro === "cifra_indisponivel"
        ? t("A cifra do servidor não está disponível; a chave não foi gravada.")
        : t("Não consegui gravar a chave."),
      500,
      { requestId },
    );
  }
  await audit({
    // Valor trocado (com ou sem endereços) é "chave_trocada"; só endereços, "chave_enderecos_trocados".
    action:
      corpo.data.valor !== undefined
        ? "automacao.chave_trocada"
        : "automacao.chave_enderecos_trocados",
    actorUserId: p.atorId,
    organizationId: org,
    resourceType: "automacao_segredos",
    resourceId: id,
    requestId,
    // O QUE mudou: o nome e, se mudaram, os endereços antes e depois. Nunca o valor.
    metadata: {
      nome: r.segredo.nome,
      ...(novosHosts !== undefined
        ? { hosts_antes: hostsAntes, hosts_depois: r.segredo.hosts_permitidos }
        : {}),
    },
  });
  return ok(r.segredo, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const p = await portaDoCofre(req, true);
  if (p.resposta) return p.resposta;
  const { org, requestId, t } = p;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId });

  const admin = createAdminClient();
  try {
    const atual = await lerSegredoVisivel(admin, org, id);
    if (!atual) return fail("not_found", t("Chave não encontrada."), 404, { requestId });
    const usam = await automacoesQueUsam(admin, org, id);
    if (usam.length > 0) {
      return fail(
        "segredo_em_uso",
        `${t("Esta chave é usada por automação publicada. Troque a chave nestas automações (ou desative-as) antes de apagar:")} ${usam.join(", ")}`,
        409,
        { requestId, details: { automacoes: usam } },
      );
    }
    const removeu = await apagarSegredo(admin, org, id);
    if (removeu) {
      await audit({
        action: "automacao.chave_apagada",
        actorUserId: p.atorId,
        organizationId: org,
        resourceType: "automacao_segredos",
        resourceId: id,
        requestId,
        metadata: { nome: atual.nome },
      });
    }
    return ok({ id, removida: removeu }, { requestId });
  } catch {
    return fail("internal_error", t("Não consegui apagar a chave."), 500, { requestId });
  }
}
