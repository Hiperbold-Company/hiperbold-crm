/**
 * /api/v1/channels/meta-social/selecao?plataforma=instagram|messenger — a
 * ESCOLHA das contas da Meta que o callback do OAuth deixou pendente (D-242).
 *
 *   GET    lista as contas que o token alcança, para a pessoa marcar as desta
 *          empresa. Nenhum token sai, nem o nome de outra organização.
 *   POST   `{ ids }` conecta SÓ as marcadas. Os ids são filtro sobre o que a
 *          redescoberta devolve: id fora dele é ignorado.
 *   DELETE cancela: queima o nonce (a escolha não vale mais em lugar nenhum) e
 *          apaga o cookie, sem efeito na Meta.
 *
 * Caminho COM sessão (não está em `lib/auth/public-paths.ts`): a chamada parte
 * da tela, no nosso próprio site. A escolha vem do cookie selado
 * (`lib/channels/meta-social/selecao.ts`), e a organização, a pessoa e a SESSÃO
 * DE LOGIN dele têm de ser as da sessão atual: quem troca de empresa no mesmo
 * navegador não conecta na empresa nova a escolha aberta na anterior, e uma
 * cópia do cookie não vale noutra sessão.
 *
 * O token-fonte vem cifrado pela chave do BANCO dentro do cookie; só aqui, com
 * o cliente de serviço, ele é decifrado.
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
  decifrarTokenDaSelecao,
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

type Admin = ReturnType<typeof createAdminClient>;

type Leitura =
  | { ok: true; selecao: SelecaoMetaSocial; plataforma: PlataformaMetaSocial; tokenFonte: string; sessaoAtual: string }
  /** `recusa` = a escolha existe mas não é desta empresa/pessoa/sessão (vai para a trilha). */
  | { ok: false; response: Response; recusa?: string };

function abrirDoCookie(req: NextRequest, plataforma: PlataformaMetaSocial): SelecaoMetaSocial | null {
  try {
    return abrirSelecaoMetaSocial(req.cookies.get(NOME_DA_SELECAO_META_SOCIAL)?.value, {
      segredo: env.INTERNAL_SECRET,
      agora: new Date(),
      plataforma,
    });
  } catch {
    return null;
  }
}

/**
 * Abre o cookie e confere que a escolha é desta organização, desta pessoa e
 * desta sessão de login; então decifra o token-fonte. Nada aqui tem efeito: a
 * escolha só se gasta depois, no POST.
 */
async function lerSelecao(
  req: NextRequest,
  admin: Admin,
  auth: { orgId: string; userId: string },
  requestId: string,
): Promise<Leitura> {
  const lido = consulta.safeParse({ plataforma: req.nextUrl.searchParams.get("plataforma") });
  if (!lido.success) {
    return { ok: false, response: fail("validation_error", "Plataforma inválida.", 400, { requestId, headers }) };
  }
  const { plataforma } = lido.data;
  const selecao = abrirDoCookie(req, plataforma);
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
      recusa: "selecao_de_outra_empresa",
      response: fail(
        "selecao_de_outra_empresa",
        `Esta escolha foi aberta em outra empresa ou por outra pessoa. ${REFACA}`,
        403,
        { requestId, headers },
      ),
    };
  }
  // A sessão de login é resolvida aqui, ANTES de qualquer efeito: se ela não
  // se resolve, a escolha não se gasta.
  let sessaoAtual: string;
  try {
    sessaoAtual = await authenticatedSessionId();
  } catch {
    return {
      ok: false,
      response: fail("sessao_indisponivel", "Não foi possível confirmar a sua sessão. Tente de novo.", 503, {
        requestId,
        headers,
      }),
    };
  }
  if (selecao.authSessionId && selecao.authSessionId !== sessaoAtual) {
    return {
      ok: false,
      recusa: "selecao_de_outra_sessao",
      response: fail("selecao_de_outra_sessao", `Esta escolha foi aberta em outra sessão. ${REFACA}`, 403, {
        requestId,
        headers,
      }),
    };
  }
  const tokenFonte = await decifrarTokenDaSelecao(admin, selecao.tokenFonteCifrado);
  if (!tokenFonte) {
    return {
      ok: false,
      response: fail(
        "cifra_indisponivel",
        "O sistema não conseguiu abrir a escolha com segurança. Avise quem cuida do servidor.",
        503,
        { requestId, headers },
      ),
    };
  }
  return { ok: true, selecao, plataforma, tokenFonte, sessaoAtual };
}

async function appDa(plataforma: PlataformaMetaSocial) {
  const cfg = await configMetaSocial();
  return plataforma === "instagram" ? cfg.instagram : cfg.messenger;
}

/** Queima o nonce da escolha. `true` = queimado agora; `false` = já estava; lança em outra falha. */
async function queimarNonce(admin: Admin, selecao: SelecaoMetaSocial, userId: string): Promise<boolean> {
  const { error } = await admin.from("calendar_oauth_nonces").insert({
    nonce: selecao.nonce,
    organization_id: selecao.organizationId,
    user_id: userId,
    expira_em: new Date(selecao.expiraEmMs).toISOString(),
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error("nonce_indisponivel");
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const lido = await lerSelecao(req, admin, { orgId: auth.org.orgId, userId: auth.user.id }, requestId);
  if (!lido.ok) return lido.response;
  const { selecao, plataforma, tokenFonte } = lido;

  try {
    const app = await appDa(plataforma);
    if (!app) return fail("nao_configurado", "A conexão ainda não foi liberada nesta instalação.", 503, { requestId, headers });
    const contas = await redescobrir(selecao.modo, app, tokenFonte);
    const situacao = await situacaoDasContas(
      admin,
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

  const organizationId = auth.org.orgId;
  const plataformaPedida = req.nextUrl.searchParams.get("plataforma") ?? "-";
  const registrarFalha = (motivo: string, detalhe?: string) =>
    audit({
      action: "channel.meta_social_connect_failed",
      organizationId,
      actorUserId: auth.user.id,
      resourceType: "channel_session",
      requestId,
      metadata: { plataforma: plataformaPedida, motivo, origem: "selecao", ...(detalhe ? { detalhe } : {}) },
    });

  // O corpo é validado ANTES de queimar o nonce: um corpo malformado não gasta a escolha.
  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) {
    return fail("validation_error", "Escolha de 1 a 20 contas.", 400, { requestId, headers });
  }
  const admin = createAdminClient();
  const lido = await lerSelecao(req, admin, { orgId: organizationId, userId: auth.user.id }, requestId);
  if (!lido.ok) {
    if (lido.recusa) await registrarFalha("retorno_nao_verificavel", `selecao_recusada:${lido.recusa}`);
    return lido.response;
  }
  const { selecao, plataforma, tokenFonte, sessaoAtual } = lido;

  try {
    const app = await appDa(plataforma);
    if (!app) return fail("nao_configurado", "A conexão ainda não foi liberada nesta instalação.", 503, { requestId, headers });

    // Redescobre ANTES de queimar: a Meta fora do ar não gasta a escolha.
    const escolhidos = new Set(dados.data.ids);
    const contas = (await redescobrir(selecao.modo, app, tokenFonte)).filter((c) => escolhidos.has(c.conta.id));
    if (contas.length === 0) {
      return fail("nenhuma_conta_escolhida", "Nenhuma das contas marcadas está disponível. Marque de novo.", 422, {
        requestId,
        headers,
      });
    }

    let queimado: boolean;
    try {
      queimado = await queimarNonce(admin, selecao, auth.user.id);
    } catch {
      return fail("internal_error", "Não foi possível confirmar a escolha. Tente de novo.", 503, { requestId, headers });
    }
    if (!queimado) {
      await registrarFalha("retorno_nao_verificavel", "selecao_recusada:selecao_ja_usada");
      return limparSelecao(
        fail("selecao_ja_usada", `Esta escolha já foi usada. ${REFACA}`, 409, { requestId, headers }),
      );
    }

    const resultado = await conectarDescobertas(admin, {
      organizationId,
      plataforma,
      contas,
      expiraEm: selecao.expiraEm,
      ator: { userId: auth.user.id, authSessionId: sessaoAtual, requestId },
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

/**
 * Cancelar a escolha: nada foi conectado e nada vai à Meta. Quando o cookie
 * abre e é desta empresa e desta pessoa, o nonce é queimado — uma cópia do
 * cookie deixa de valer. Cookie ausente, inválido ou de outra empresa: só apaga.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  const lido = consulta.safeParse({ plataforma: req.nextUrl.searchParams.get("plataforma") });
  const selecao = lido.success ? abrirDoCookie(req, lido.data.plataforma) : null;
  if (selecao && selecao.organizationId === auth.org.orgId && selecao.userId === auth.user.id) {
    try {
      // `false` (23505) = já queimado: o cancelamento segue igual.
      await queimarNonce(createAdminClient(), selecao, auth.user.id);
    } catch {
      logger.warn("[meta-social.selecao] cancelamento sem queimar o nonce", { organization_id: auth.org.orgId });
    }
  }
  return limparSelecao(ok({ cancelada: true }, { requestId, headers }));
}
