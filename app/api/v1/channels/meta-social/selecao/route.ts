/**
 * /api/v1/channels/meta-social/selecao?plataforma=instagram|messenger — a
 * ESCOLHA das contas da Meta que o callback do OAuth deixou pendente (D-242).
 *
 *   GET    lista as contas que o token alcança, para a pessoa marcar as desta
 *          empresa. Nenhum token sai, nem o nome de outra organização.
 *   POST   `{ ids }` conecta SÓ as marcadas. Os ids são filtro sobre o que a
 *          redescoberta devolve: id fora dele é ignorado.
 *   DELETE cancela: apaga o cookie, sem efeito na Meta.
 *
 * Caminho COM sessão (não está em `lib/auth/public-paths.ts`): a chamada parte
 * da tela, no nosso próprio site. A escolha vem do cookie selado
 * (`lib/channels/meta-social/selecao.ts`), e a organização e a pessoa dele têm
 * de ser as da sessão ATUAL: quem troca de empresa no mesmo navegador não
 * conecta na empresa nova a escolha aberta na anterior.
 *
 * A confirmação queima o nonce da escolha em `calendar_oauth_nonces` antes de
 * conectar (23505 = já usada): a mesma escolha não conecta duas vezes.
 * Assinar o webhook na Meta só acontece dentro de `conectarConta`, então conta
 * não marcada não tem efeito nenhum.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import { PLATAFORMAS_META_SOCIAL, type PlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";
import { conectarDescobertas, redescobrir } from "@/lib/channels/meta-social/descoberta";
import { ErroDaMeta } from "@/lib/channels/meta-social/oauth";
import {
  NOME_DA_SELECAO_META_SOCIAL,
  abrirSelecaoMetaSocial,
  type SelecaoMetaSocial,
} from "@/lib/channels/meta-social/selecao";
import { situacaoDasContas } from "@/lib/channels/meta-social/store";
import { limparSelecao } from "@/lib/channels/meta-social/volta";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const consulta = z.object({ plataforma: z.enum(PLATAFORMAS_META_SOCIAL) });

/** Id de conta da Meta: só dígitos (IG_ID 17841…, id de Página). */
const corpo = z.object({
  ids: z
    .array(z.string().regex(/^\d{1,30}$/))
    .min(1)
    .max(20),
});

const REFACA = "Clique em Conectar de novo para escolher as contas.";

type Leitura =
  | { ok: true; selecao: SelecaoMetaSocial; plataforma: PlataformaMetaSocial }
  | { ok: false; response: Response };

/** Abre o cookie e confere que a escolha é desta organização e desta pessoa. */
function lerSelecao(req: NextRequest, auth: { orgId: string; userId: string }, requestId: string): Leitura {
  const lido = consulta.safeParse({ plataforma: req.nextUrl.searchParams.get("plataforma") });
  if (!lido.success) {
    return { ok: false, response: fail("validation_error", "Plataforma inválida.", 400, { requestId, headers }) };
  }
  const { plataforma } = lido.data;
  let selecao: SelecaoMetaSocial | null = null;
  try {
    selecao = abrirSelecaoMetaSocial(req.cookies.get(NOME_DA_SELECAO_META_SOCIAL)?.value, {
      segredo: env.INTERNAL_SECRET,
      agora: new Date(),
      plataforma,
    });
  } catch {
    selecao = null;
  }
  if (!selecao) {
    return {
      ok: false,
      response: limparSelecao(
        fail("selecao_expirada", `A escolha das contas expirou. ${REFACA}`, 410, { requestId, headers }),
      ),
    };
  }
  if (selecao.organizationId !== auth.orgId || selecao.userId !== auth.userId) {
    // Não apaga o cookie: na empresa (e com a pessoa) certa ela ainda vale.
    return {
      ok: false,
      response: fail(
        "selecao_de_outra_empresa",
        `Esta escolha foi aberta em outra empresa ou por outra pessoa. ${REFACA}`,
        403,
        { requestId, headers },
      ),
    };
  }
  return { ok: true, selecao, plataforma };
}

async function appDa(plataforma: PlataformaMetaSocial) {
  const cfg = await configMetaSocial();
  return plataforma === "instagram" ? cfg.instagram : cfg.messenger;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  const lido = lerSelecao(req, { orgId: auth.org.orgId, userId: auth.user.id }, requestId);
  if (!lido.ok) return lido.response;
  const { selecao, plataforma } = lido;

  try {
    const app = await appDa(plataforma);
    if (!app) return fail("nao_configurado", "A conexão ainda não foi liberada nesta instalação.", 503, { requestId, headers });
    const contas = await redescobrir(selecao.modo, app, selecao.tokenFonte);
    const situacao = await situacaoDasContas(
      createAdminClient(),
      auth.org.orgId,
      plataforma,
      contas.map((c) => c.conta.id),
    );
    return ok(
      {
        plataforma,
        expira_em: new Date(selecao.expiraEmMs).toISOString(),
        // Lista montada campo a campo: token, id da Página e qualquer outro dado
        // da descoberta ficam no servidor.
        contas: contas.map((c) => ({
          id: c.conta.id,
          nome: c.conta.nome,
          usuario: c.conta.usuario,
          ja_conectada_aqui: situacao.get(c.conta.id) === "aqui",
          em_outra_empresa: situacao.get(c.conta.id) === "outra",
        })),
      },
      { requestId, headers },
    );
  } catch (err) {
    if (err instanceof ErroDaMeta) {
      return fail("meta_recusou", "A Meta não respondeu. Tente de novo em alguns minutos.", 502, { requestId, headers });
    }
    logger.error("[meta-social.selecao] listagem falhou", {
      organization_id: auth.org.orgId,
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return fail("internal_error", "Não foi possível listar as contas.", 500, { requestId, headers });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId, headers });

  // O corpo é validado ANTES de queimar o nonce: um corpo malformado não gasta a escolha.
  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) {
    return fail("validation_error", "Escolha de 1 a 20 contas.", 400, { requestId, headers });
  }
  const lido = lerSelecao(req, { orgId: auth.org.orgId, userId: auth.user.id }, requestId);
  if (!lido.ok) return lido.response;
  const { selecao, plataforma } = lido;
  const organizationId = auth.org.orgId;

  const registrarFalha = (motivo: string, detalhe?: string) =>
    audit({
      action: "channel.meta_social_connect_failed",
      organizationId,
      actorUserId: auth.user.id,
      resourceType: "channel_session",
      requestId,
      metadata: { plataforma, motivo, origem: "selecao", ...(detalhe ? { detalhe } : {}) },
    });

  try {
    const app = await appDa(plataforma);
    if (!app) return fail("nao_configurado", "A conexão ainda não foi liberada nesta instalação.", 503, { requestId, headers });

    // Redescobre ANTES de queimar: a Meta fora do ar não gasta a escolha.
    const escolhidos = new Set(dados.data.ids);
    const contas = (await redescobrir(selecao.modo, app, selecao.tokenFonte)).filter((c) =>
      escolhidos.has(c.conta.id),
    );
    if (contas.length === 0) {
      return fail("nenhuma_conta_escolhida", "Nenhuma das contas marcadas está disponível. Marque de novo.", 422, {
        requestId,
        headers,
      });
    }

    const admin = createAdminClient();
    const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
      nonce: selecao.nonce,
      organization_id: organizationId,
      user_id: auth.user.id,
      expira_em: new Date(selecao.expiraEmMs).toISOString(),
    });
    if (erroDoNonce) {
      if (erroDoNonce.code === "23505") {
        return limparSelecao(
          fail("selecao_ja_usada", `Esta escolha já foi usada. ${REFACA}`, 409, { requestId, headers }),
        );
      }
      return fail("internal_error", "Não foi possível confirmar a escolha. Tente de novo.", 503, { requestId, headers });
    }

    const resultado = await conectarDescobertas(admin, {
      organizationId,
      plataforma,
      contas,
      expiraEm: selecao.expiraEm,
      ator: {
        userId: auth.user.id,
        authSessionId: (await authenticatedSessionId()) ?? selecao.authSessionId,
        requestId,
      },
      autorizadorId: selecao.autorizadorId,
      empresaId: selecao.empresaId,
    });
    if (resultado.primeiraRecusa) {
      await registrarFalha(
        resultado.primeiraRecusa,
        `escolha:${resultado.conectadas}/${resultado.conectadas + resultado.recusadas}`,
      );
    }
    return limparSelecao(
      ok(
        {
          conectadas: resultado.conectadas,
          recusadas: resultado.recusadas,
          ...(resultado.primeiraRecusa ? { motivo: resultado.primeiraRecusa } : {}),
        },
        { requestId, headers },
      ),
    );
  } catch (err) {
    if (err instanceof ErroDaMeta) {
      return fail("meta_recusou", "A Meta não respondeu. Tente de novo em alguns minutos.", 502, { requestId, headers });
    }
    logger.error("[meta-social.selecao] confirmação falhou", {
      organization_id: organizationId,
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    await registrarFalha("falha_inesperada");
    return limparSelecao(fail("internal_error", "Algo deu errado ao conectar. Tente de novo.", 500, { requestId, headers }));
  }
}

/** Cancelar a escolha: só apaga o cookie. Nada foi conectado e nada vai à Meta. */
export async function DELETE(): Promise<Response> {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  return limparSelecao(ok({ cancelada: true }, { requestId, headers }));
}
