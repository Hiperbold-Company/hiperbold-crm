/**
 * GET /api/v1/channels/meta-social/callback/{instagram|messenger} — a volta do
 * consentimento da Meta.
 *
 * Caminho PÚBLICO no proxy (`lib/auth/public-paths.ts`): a navegação vem de
 * outro site e o cookie de sessão (`SameSite=Strict`) não viaja nela. A
 * identidade vem do `state` assinado (organização, usuário, sessão de login,
 * plataforma), somado ao cookie de vínculo `Lax` que prova que o navegador que
 * volta é o que saiu, ao nonce de uso único e a uma reconferência no banco de
 * que a pessoa AINDA é administrador ou gerente da organização (o mesmo piso de
 * `conectar`, desde 03/11/2026).
 *
 * A ordem é contrato (molde do callback da agenda):
 *   1. `error` da Meta → a pessoa cancelou; volta sem barulho.
 *   2. `state` antes do `code`: sem saber de quem é, não há org para auditar.
 *   3. vínculo do navegador.
 *   4. autoridade atual (papel no banco + cerca do suporte) antes de efeito.
 *   5. QUEIMA do nonce antes de trocar o código: replay morre aqui (23505).
 *   6. troca do código, conta(s), conexão.
 *
 * Todo desfecho volta para `/app/connections?aba=sociais&meta_social=ok|erro|parcial
 * &motivo=<código>&n=<quantas contas>&recusadas=<quantas não>`. Com DUAS ou mais
 * contas descobertas nada é conectado: volta `meta_social=escolher&plataforma=<x>`
 * com o cookie selado da escolha (`lib/channels/meta-social/selecao.ts`), e a
 * tela pergunta quais contas são desta empresa (D-242). Os códigos de
 * `motivo` são os de `lib/channels/meta-social/motivos.ts`, o mesmo conjunto
 * que a tela traduz.
 *
 * Auditoria antes de queimar o nonce NÃO leva a organização do `state`: até
 * ali o `state` pode ser uma cópia (vazou de um histórico, de um log), e quem a
 * tem não pode escrever trilha na organização de outra pessoa. Depois do nonce
 * queimado o `state` é deste navegador e deste uso, e a falha vai para a
 * organização dele.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/types";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import { PLATAFORMAS_META_SOCIAL, caminhoDoCallback, type PlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";
import { NOME_DO_VINCULO_META_SOCIAL, verificarEstadoMetaSocial, vinculoMetaSocialConfere } from "@/lib/channels/meta-social/estado";
import {
  conectarDescobertas,
  descobrirMessenger,
  descobrirPelasPaginas,
  descobrirPeloSistema,
  type ContaDescoberta,
} from "@/lib/channels/meta-social/descoberta";
import {
  ErroDaMeta,
  tokenLongoMessenger,
  trocarCodigoLoginUnificado,
  trocarCodigoMessenger,
  usuarioDoFacebook,
  usuarioDoSistema,
} from "@/lib/channels/meta-social/oauth";
import type { MotivoDaVolta } from "@/lib/channels/meta-social/motivos";
import {
  cifrarTokenDaSelecao,
  selarSelecaoMetaSocial,
  type ModoDaDescoberta,
} from "@/lib/channels/meta-social/selecao";
import { ConexaoRecusada, type Ator } from "@/lib/channels/meta-social/store";
import { redirectUriDe, voltarParaConexoes, voltarParaEscolher } from "@/lib/channels/meta-social/volta";
import { env } from "@/lib/env";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const parametros = z.object({ plataforma: z.enum(PLATAFORMAS_META_SOCIAL) });

interface RouteCtx {
  params: Promise<{ plataforma: string }>;
}

const erro = (motivo: MotivoDaVolta) => voltarParaConexoes({ meta_social: "erro", motivo, n: 0 });

/** A pessoa do `state` ainda é administrador ou gerente da organização (ou admin de plataforma ativo)? */
async function aindaAdministra(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const { data: vinculo } = await admin
    .from("user_organizations")
    .select("role, revoked_at")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  const v = vinculo as { role: string; revoked_at: string | null } | null;
  // Mesmo piso de `conectar` (`requireRole("manager")`): decisão do dono do produto, 03/11/2026.
  if (v && v.revoked_at === null && roleAtLeast(v.role, "manager")) return true;
  const { data: plataforma } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  return Boolean(plataforma);
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const lido = parametros.safeParse(await ctx.params);
  if (!lido.success) return erro("plataforma_invalida");
  const plataforma: PlataformaMetaSocial = lido.data.plataforma;
  const url = req.nextUrl;

  if (url.searchParams.get("error")) return erro("conexao_cancelada");

  let estado: ReturnType<typeof verificarEstadoMetaSocial> = null;
  try {
    estado = verificarEstadoMetaSocial(url.searchParams.get("state"), {
      segredo: env.INTERNAL_SECRET,
      agora: new Date(),
      plataforma,
    });
  } catch {
    return erro("retorno_nao_verificavel");
  }
  if (!estado) return erro("retorno_nao_verificavel");
  const { organizationId, userId } = estado;
  /** Falha ANTES de o nonce ser queimado: trilha da instalação, sem a organização do state. */
  const recusouSemVinculo = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await audit({
      action: "channel.meta_social_connect_failed",
      resourceType: "channel_session",
      metadata: { plataforma, motivo, ...(detalhe ? { detalhe } : {}) },
    });
    return erro(motivo);
  };
  /** Falha DEPOIS do nonce queimado: o state é deste uso, a trilha vai para a organização dele. */
  const registrarFalha = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await audit({
      action: "channel.meta_social_connect_failed",
      organizationId,
      actorUserId: userId,
      actorAuthSessionId: estado?.authSessionId,
      resourceType: "channel_session",
      metadata: { plataforma, motivo, ...(detalhe ? { detalhe } : {}) },
    });
  };
  const falhou = async (motivo: MotivoDaVolta, detalhe?: string) => {
    await registrarFalha(motivo, detalhe);
    return erro(motivo);
  };

  if (!vinculoMetaSocialConfere(req.cookies.get(NOME_DO_VINCULO_META_SOCIAL)?.value, estado.nonce, env.INTERNAL_SECRET)) {
    return recusouSemVinculo("retorno_nao_verificavel", "vinculo_ausente_ou_nao_confere");
  }
  const code = url.searchParams.get("code");
  if (!code) return recusouSemVinculo("retorno_incompleto");

  const admin = createAdminClient();
  if (!(await supportCallbackWriteAllowed(organizationId, userId, estado.authSessionId))) {
    return recusouSemVinculo("retorno_nao_verificavel", "suporte_sem_escrita");
  }
  if (!(await aindaAdministra(admin, organizationId, userId))) {
    return recusouSemVinculo("sem_permissao");
  }

  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    return recusouSemVinculo(
      "retorno_nao_verificavel",
      erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel",
    );
  }

  const cfg = await configMetaSocial();
  const app = plataforma === "instagram" ? cfg.instagram : cfg.messenger;
  if (!app) return falhou("nao_configurado");

  const redirectUri = redirectUriDe(caminhoDoCallback(plataforma));
  const ator: Ator = { userId, authSessionId: estado.authSessionId };

  try {
    // A descoberta mora em `descoberta.ts`, a MESMA que a escolha usa depois:
    // no Instagram, cada conta do portfólio marcada no login (todas com o MESMO
    // token, o do usuário do sistema) ou, pela Página, cada conta com o token
    // da Página; no Messenger, cada Página (com o token dela).
    let contas: ContaDescoberta[];
    let modo: ModoDaDescoberta;
    let tokenFonte: string;
    /** Quantas Páginas a descoberta pela Página viu (com ou sem Instagram); 0 nos outros modos. */
    let paginasVistas = 0;
    let expiraEm: string | null = null;
    let autorizadorId: string | null;
    let empresaId: string | null = null;
    if (plataforma === "instagram") {
      const suat = await trocarCodigoLoginUnificado(app, code, redirectUri);
      // O mesmo callback recebe dois tipos de token: o SUAT (configuração de
      // usuário do sistema) e o de USUÁRIO (configuração com as permissões de
      // Página). Com token de usuário o `/me?fields=client_business_id` pode
      // falhar; isso não derruba a conexão.
      const sistema = await usuarioDoSistema(suat.token).catch(() => null);
      empresaId = sistema?.clientBusinessId ?? null;
      // Descoberta em três etapas, cada uma com a própria rede de proteção: a
      // falha de uma não impede a próxima, e todas entram no diagnóstico.
      // Só o SUAT tem `client_business_id`. Token de USUÁRIO vai direto à
      // Página: o debug_token dele pode listar a conta do IG, mas um token de
      // usuário não envia pelo /<IG_ID>/messages e vence em horas.
      const ehSuat = Boolean(empresaId);
      const pelaEmpresa = ehSuat ? await descobrirPeloSistema(app, suat.token) : null;
      if (pelaEmpresa && pelaEmpresa.contas.length > 0) {
        contas = pelaEmpresa.contas;
        modo = "instagram_sistema";
        tokenFonte = suat.token;
        expiraEm = suat.expiraEmSegundos ? new Date(Date.now() + suat.expiraEmSegundos * 1000).toISOString() : null;
        // O /me do SUAT é o usuário do sistema de integração, não a pessoa: a
        // exclusão de dados casa por ele E pela conta (`exclusao.ts`).
        autorizadorId = sistema?.id ?? (await usuarioDoFacebook(suat.token));
      } else {
        // Plano C: a conta pela Página que a possui (Instagram API com
        // Facebook Login); o envio e o webhook passam a usar o token da Página.
        // Token de Página derivado de token LONGO não vence; se o alongamento
        // falhar (o token pode ser SUAT, que não se alonga), segue com o próprio.
        const longo = await tokenLongoMessenger(app, suat.token).catch(() => suat.token);
        const planoC = await descobrirPelasPaginas(longo);
        if (!planoC || planoC.contas.length === 0) {
          const pistas = pelaEmpresa?.pistas ?? null;
          const planoB = pistas?.planoB ?? null;
          const alvos = planoB
            ? Object.entries(planoB.alvos)
                .map(([escopo, n]) => `${escopo}:${n}`)
                .join(",")
                .slice(0, 300)
            : "-";
          return falhou(
            "nenhuma_conta_instagram",
            [
              `assigned=${!pistas ? "-" : pistas.assigned !== null ? pistas.assigned : "falhou"}`,
              `debug_token=${planoB ? "ok" : pistas?.planoBFalhou ? "falhou" : "-"}`,
              `escopos=${(planoB?.escopos ?? []).join(",").slice(0, 300)}`,
              `alvos=${alvos}`,
              `paginas=${planoC ? `${planoC.vistas}/${planoC.contas.length}` : "falhou"}`,
            ].join(" "),
          );
        }
        contas = planoC.contas;
        paginasVistas = planoC.vistas;
        modo = "instagram_pagina";
        tokenFonte = longo;
        expiraEm = null;
        autorizadorId = await usuarioDoFacebook(longo);
      }
    } else {
      const curto = await trocarCodigoMessenger(app, code, redirectUri);
      const longo = await tokenLongoMessenger(app, curto);
      contas = await descobrirMessenger(longo);
      if (contas.length === 0) return falhou("nenhuma_pagina");
      modo = "messenger";
      tokenFonte = longo;
      autorizadorId = await usuarioDoFacebook(longo);
    }

    // Duas ou mais contas: NADA é conectado aqui (D-242). Quem marca "todas as
    // páginas" na Meta pode alcançar páginas de outros clientes; a tela
    // pergunta quais são desta empresa, e só `conectarConta` (na confirmação)
    // assina webhook na Meta. A escolha guarda o token-fonte, não as contas.
    // Pela Página, o login que alcançou VÁRIAS Páginas também pergunta, mesmo
    // com uma só tendo Instagram: quem alcança Páginas de vários clientes é
    // justamente o operador de agência, e a conta certa precisa ser confirmada.
    if (contas.length > 1 || (modo === "instagram_pagina" && paginasVistas > 1)) {
      // O token vai cifrado pela chave do BANCO: o cookie sozinho não entrega o token.
      const tokenFonteCifrado = await cifrarTokenDaSelecao(admin, tokenFonte);
      if (!tokenFonteCifrado) return falhou("cifra_indisponivel");
      const selada = selarSelecaoMetaSocial(
        {
          plataforma,
          organizationId,
          userId,
          ...(estado.authSessionId ? { authSessionId: estado.authSessionId } : {}),
          modo,
          tokenFonteCifrado,
          expiraEm,
          autorizadorId,
          empresaId,
        },
        { segredo: env.INTERNAL_SECRET, agora: new Date() },
      );
      // Só a contagem: ids e nomes das contas podem ser de outros clientes.
      await audit({
        action: "channel.meta_social_selection_opened",
        organizationId,
        actorUserId: userId,
        actorAuthSessionId: estado.authSessionId,
        resourceType: "channel_session",
        metadata: { plataforma, contas: contas.length, ...(paginasVistas ? { paginas_vistas: paginasVistas } : {}) },
      });
      return voltarParaEscolher(plataforma, selada);
    }

    // Uma conta só: conecta direto. A que estourar o limite do plano (ou
    // estiver em outra organização) volta como recusa.
    const { conectadas, recusadas, primeiraRecusa } = await conectarDescobertas(admin, {
      organizationId,
      plataforma,
      contas,
      expiraEm,
      ator,
      autorizadorId,
      empresaId,
    });
    if (primeiraRecusa && conectadas === 0) return falhou(primeiraRecusa);
    if (primeiraRecusa) {
      // Recusa PARCIAL: umas contas entraram, outras não. Dizer só "erro"
      // esconderia as que funcionam; dizer só "ok" esconderia as que faltam.
      await registrarFalha(primeiraRecusa, `parcial:${conectadas}/${conectadas + recusadas}`);
      return voltarParaConexoes({ meta_social: "parcial", n: conectadas, recusadas, motivo: primeiraRecusa, plataforma });
    }
    // `plataforma` diz à tela em cartões qual tipo abrir na volta (Instagram ou Messenger).
    return voltarParaConexoes({ meta_social: "ok", n: conectadas, plataforma });
  } catch (err) {
    if (err instanceof ConexaoRecusada) return falhou(err.motivo);
    if (err instanceof ErroDaMeta) {
      logger.warn("[meta-social.callback] a Meta recusou", {
        organization_id: organizationId,
        etapa: err.etapa,
        status: err.status,
        codigo: err.codigoDaMeta,
      });
      return falhou("meta_recusou", err.etapa);
    }
    logger.error("[meta-social.callback] falha inesperada", {
      organization_id: organizationId,
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return falhou("falha_inesperada");
  }
}
