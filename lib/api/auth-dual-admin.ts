/**
 * Porta única das rotas de ADMINISTRAÇÃO da organização que aceitam sessão OU
 * token de servidor (`Authorization: Bearer dsk_…`) — fase 1 da API (17/10/2026).
 *
 * Fica por cima de `resolveAuthDual` (`lib/api/auth-dual.ts`) e decide o que é
 * igual em todas: o escopo do token e o teto de escrita.
 *
 * ## Como o token é autorizado (moldura de menor privilégio)
 *
 *  - **Papel**: o `role:<papel>` do token (`api_tokens.scopes`) tem de alcançar o
 *    MESMO piso que a sessão exige na rota — `admin` para equipe, configuração da
 *    organização e do funil; `manager` para funil, etapas e entradas
 *    automáticas. Nunca mais baixo que a sessão, porque a rota e a tool MCP
 *    chamam o mesmo núcleo.
 *  - **Escopo**: leitura pede `mcp:read`; QUALQUER escrita pede `mcp:write`.
 *    Não existe escopo novo: quem emite uma chave só de leitura continua não
 *    conseguindo mudar nada, mesmo com `role:admin`.
 *  - **Organização**: sai da linha do token no banco. Nenhuma rota daqui lê a
 *    organização do corpo, da query ou do caminho.
 *  - **Dono**: a chave só vale enquanto quem a criou ainda pode o que ela pode
 *    (`lib/mcp/auth.ts`, D-101) — admin rebaixado leva a chave junto.
 *
 * ## O que o token NÃO tem: segundo fator
 *
 * MFA é propriedade de uma SESSÃO de navegador (`aal2`); um token não tem. Onde
 * a sessão é barrada por `mfa_required` (políticas de `lib/auth/politica-mfa.ts`),
 * o token passa — o limite de confiança é a emissão da chave: só um `admin` cria
 * chave `role:admin`, a chave aparece uma única vez, é revogável e morre com o
 * criador. Por isso `role:admin` + `mcp:write` é uma credencial de administrador
 * e deve ser tratada como tal (expiração curta, uma por integração).
 *
 * ⚠️ Não basta chamar isto na rota: o `proxy.ts` só reconhece cookie. Cada caminho
 * precisa de uma entrada ANCORADA em `lib/auth/public-paths.ts`.
 */
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import type { Role } from "@/lib/auth/types";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { checkRateLimit, devolverRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "./auth-dual";

export type AuthAdminOk = Extract<AuthDual, { ok: true }>;
export type ResultadoAuthAdmin = AuthAdminOk | { ok: false; response: Response };

export const ESCOPO_DE_LEITURA = "mcp:read";
export const ESCOPO_DE_ESCRITA = "mcp:write";

export interface OpcoesAuthAdmin {
  requestId: string;
  /** `resource_type` do `authz.denied` e nome do balde do teto (`team`, `crm_pipelines`…). */
  resource: string;
  /** Piso de papel — o MESMO da sessão. */
  role: Role;
  /** `true` em POST/PATCH/DELETE: pede `mcp:write` e conta no teto de escrita. */
  escrita: boolean;
  /** A rota lê/escreve dado com dono por atendente (ver `AuthDualOptions.comDono`). */
  comDono?: boolean;
  /** Piso do TOKEN quando a operação é mais destrutiva que o da sessão (ver `AuthDualOptions.tokenRole`). */
  tokenRole?: Role;
}

export async function autorizarAdministracao(
  req: NextRequest,
  { requestId, resource, role, escrita, comDono, tokenRole }: OpcoesAuthAdmin,
): Promise<ResultadoAuthAdmin> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource,
    role,
    scope: escrita ? ESCOPO_DE_ESCRITA : ESCOPO_DE_LEITURA,
    comDono,
    tokenRole,
  });
  if (!authz.ok) return authz;

  // São operações de ADMINISTRAÇÃO, de gente: o token temporário do agente
  // publicado (`actor:ai_agent`, `role:ai_operator`) e qualquer chave marcada como
  // agente de IA não as exercem — o agente não administra a empresa em que atende.
  if (authz.via === "token" && authz.actor.type === "ai_agent") {
    return {
      ok: false,
      response: fail("forbidden", "AI agent tokens cannot perform administration operations.", 403, {
        requestId,
      }),
    };
  }

  if (escrita) {
    const teto = await tetoDeEscritaDoToken(authz, resource, requestId);
    if (teto) return { ok: false, response: teto };
  }
  return authz;
}

/** Quem assina o `api_audit_log`: a pessoa (sessão) OU o token — nunca os dois. */
export function atorDoAudit(authz: AuthAdminOk): {
  actorUserId: string | null;
  actorApiTokenId: string | null;
} {
  if (authz.via === "token") {
    return { actorUserId: null, actorApiTokenId: authz.apiTokenId ?? null };
  }
  return { actorUserId: authz.actor.id, actorApiTokenId: null };
}

/**
 * A PESSOA responsável pela ação, para colunas com FK em `auth.users`
 * (`invited_by`, `revoked_by`): quem está na sessão, ou o dono do token.
 */
export function pessoaResponsavel(authz: AuthAdminOk): string | null {
  return authz.via === "token" ? (authz.donoDoToken ?? null) : authz.actor.id;
}

export function traducaoDe(authz: AuthAdminOk): (texto: string) => string {
  return (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
}

/**
 * O nome da organização, para texto que sai dela (e-mail de convite). A sessão
 * já o carregava em `ActiveOrg`; o token não, então lê-se da linha — filtrada
 * pela organização que o token resolveu, nunca por id vindo do cliente.
 */
export async function nomeDaOrganizacao(authz: AuthAdminOk): Promise<string> {
  const { data } = await authz.supabase
    .from("organizations")
    .select("display_name")
    .eq("id", authz.organizationId)
    .maybeSingle();
  const nome = (data as { display_name?: string | null } | null)?.display_name;
  return nome && nome.trim() ? nome : "—";
}

/**
 * O nome de quem responde pela ação, para texto que sai para fora ("X convidou
 * você"). Sessão: o usuário logado. Token: o DONO da chave, lido na GoTrue pelo
 * id que o banco guardou — nunca um nome vindo do cliente. Sem nome, o texto
 * neutro que a rota já usava.
 */
export async function nomeDeQuemAgiu(authz: AuthAdminOk): Promise<string> {
  const neutro = "Um colega";
  try {
    if (authz.via === "session") {
      const u = await loadAuthUser();
      return u?.full_name ?? u?.email ?? neutro;
    }
    if (!authz.donoDoToken) return neutro;
    const { data } = await createAdminClient().auth.admin.getUserById(authz.donoDoToken);
    const meta = data?.user?.user_metadata as { full_name?: string } | undefined;
    return meta?.full_name ?? data?.user?.email ?? neutro;
  } catch {
    return neutro;
  }
}

/**
 * Teto por ORGANIZAÇÃO para envio de convite por e-mail, por qualquer porta
 * (sessão ou token): `MAX_CONVITES_POR_HORA` e-mails por hora, e no mínimo
 * `INTERVALO_DE_REENVIO_SEGUNDOS` entre dois reenvios do MESMO convite. Convite
 * dispara e-mail de verdade com o nome da empresa — sem teto, uma chave (ou uma
 * aba em laço) vira máquina de spam com o remetente da instalação.
 *
 * RESERVA E DEVOLUÇÃO. A vaga é tomada ANTES do efeito, por incremento atômico (é isso que
 * impede requisições concorrentes de passarem juntas do teto — ler primeiro e gastar depois
 * deixava todas passarem), e é DEVOLVIDA quando o convite não se concretiza (e-mail inválido,
 * recusa do plano, erro, e-mail que não saiu). Vaga queimada por convite que falhou trancaria
 * a organização por até uma hora sem um único e-mail enviado.
 */
export const MAX_CONVITES_POR_HORA = 20;
export const INTERVALO_DE_REENVIO_SEGUNDOS = 600;

const JANELA_DE_CONVITES_SEGUNDOS = 3600;

/** Vaga tomada: `devolver()` desfaz o gasto (idempotente; nunca lança). */
export interface ReservaDeConvite {
  /** `false` quando o teto está cheio — nesse caso nada foi gasto e `devolver` é no-op. */
  concedida: boolean;
  devolver: () => Promise<void>;
}

async function reservar(bucket: string, limite: number, janelaSegundos: number): Promise<ReservaDeConvite> {
  const r = await checkRateLimit(bucket, limite, janelaSegundos);
  let devolvida = false;
  const devolver = async (): Promise<void> => {
    if (devolvida) return;
    devolvida = true;
    try {
      await devolverRateLimit(bucket, janelaSegundos, r.window_start);
    } catch {
      // compensação best-effort: o pior caso é a vaga voltar sozinha quando a janela vira
    }
  };
  if (!r.allowed) {
    // A tentativa barrada também incrementou o contador: devolve, senão ela ocuparia a vaga de quem vem depois.
    await devolver();
    return { concedida: false, devolver: async () => undefined };
  }
  return { concedida: true, devolver };
}

/** Toma uma vaga de e-mail de convite desta organização na hora corrente. */
export function reservarVagaDeConvite(organizationId: string): Promise<ReservaDeConvite> {
  return reservar(`convite:org:${organizationId}`, MAX_CONVITES_POR_HORA, JANELA_DE_CONVITES_SEGUNDOS);
}

/** Toma o direito de reenviar ESTE convite agora (o intervalo mínimo entre reenvios já passou). */
export function reservarReenvioDeConvite(organizationId: string, conviteId: string): Promise<ReservaDeConvite> {
  return reservar(`reenvio:${organizationId}:${conviteId}`, 1, INTERVALO_DE_REENVIO_SEGUNDOS);
}
