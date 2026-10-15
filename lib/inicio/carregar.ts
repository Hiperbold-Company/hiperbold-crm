/**
 * Lê do banco o que `primeirosPassos` precisa. Toda leitura filtra `organization_id` da organização
 * ATIVA, resolvida no servidor por `resolveActiveOrg` (nunca do corpo ou da URL), e vai pelo admin
 * client: `user_organizations` só deixa o usuário ler a PRÓPRIA linha (não dá para contar a equipe
 * pelo client de sessão) e `organizations` só tem policy de escrita para o admin da plataforma.
 *
 * Nunca lança. Uma leitura que falha vira o valor "não feito" daquele item e grita no log
 * (`alarme_inicio_leitura`): o Início é uma tela de orientação, não pode cair por causa de uma
 * consulta, e quem barra o uso do produto é o banco, não esta lista. A exceção é a confirmação de
 * e-mail, que é fail-open (ver `./email-verificado.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { compraPeloClienteDisponivel } from "@/lib/onboarding/precisa-pagar";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

import { emailVerificado } from "./email-verificado";
import { primeirosPassos, type DadosDosPrimeirosPassos, type PrimeirosPassos } from "./primeiros-passos";

/** Status de um canal que entrega e recebe mensagem (contrato do CRM, `lib/channels/health.ts`). */
const STATUS_CONECTADO = "WORKING";

async function ler<T>(etapa: string, organizationId: string, padrao: T, leitura: () => PromiseLike<T>): Promise<T> {
  try {
    return await leitura();
  } catch (err) {
    logger.error("alarme_inicio_leitura", {
      organization_id: organizationId,
      etapa,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return padrao;
  }
}

/** Erro do PostgREST vira exceção, para `ler` tratar tudo no mesmo lugar. */
function ok<T>(r: { data: T | null; error: { message: string } | null }): T | null {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

export async function carregarDadosDosPrimeirosPassos(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
  /** Quem já perguntou se a compra está ligada passa a resposta e poupa a segunda consulta. */
  compraJaConsultada?: boolean,
): Promise<DadosDosPrimeirosPassos> {
  const compraLigada = compraJaConsultada ?? (await compraPeloClienteDisponivel(admin));

  const [planoAtivo, verificado, org, whatsappConectado, agentePublicado, followupAtivo, membrosAtivos, modulos] =
    await Promise.all([
      compraLigada
        ? ler("plano", organizationId, false, async () => {
            const linha = ok(
              await admin
                .from("billing_contracts")
                .select("status")
                .eq("organization_id", organizationId)
                .maybeSingle<{ status: string }>(),
            );
            return linha?.status === "ativa" || linha?.status === "avaliacao";
          })
        : Promise.resolve(false),
      compraLigada ? emailVerificado(admin, userId) : Promise.resolve(false),
      ler("organizacao", organizationId, null, async () =>
        ok(
          await admin
            .from("organizations")
            .select("timezone, onboarding_state, settings")
            .eq("id", organizationId)
            .maybeSingle<{ timezone: string | null; onboarding_state: unknown; settings: unknown }>(),
        ),
      ),
      ler("whatsapp", organizationId, false, async () => {
        const { count, error } = await admin
          .from("channel_sessions")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("status", STATUS_CONECTADO)
          .is("archived_at", null)
          .in("provider", [...PROVIDERS_DE_MENSAGEM]);
        if (error) throw new Error(error.message);
        return (count ?? 0) > 0;
      }),
      ler("agente", organizationId, false, async () => {
        const { count, error } = await admin
          .from("ai_agents")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .not("published_version_id", "is", null)
          .is("archived_at", null);
        if (error) throw new Error(error.message);
        return (count ?? 0) > 0;
      }),
      ler("followup", organizationId, false, async () => {
        const { count, error } = await admin
          .from("followup_flow_pointers")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .not("active_version_id", "is", null);
        if (error) throw new Error(error.message);
        return (count ?? 0) > 0;
      }),
      ler("equipe", organizationId, 0, async () => {
        const { count, error } = await admin
          .from("user_organizations")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .is("revoked_at", null);
        if (error) throw new Error(error.message);
        return count ?? 0;
      }),
      modulosLigados(admin),
    ]);

  const welcome = (org?.onboarding_state as { welcome?: { o_que_faz?: unknown } } | null | undefined)?.welcome;
  const oQueFaz = typeof welcome?.o_que_faz === "string" ? welcome.o_que_faz : null;
  const marca = marcaDaOrganizacaoDeSettings(org?.settings ?? null);

  return {
    compraLigada,
    planoAtivo,
    emailVerificado: verificado,
    oQueFaz,
    fuso: org?.timezone ?? null,
    whatsappConectado,
    agentePublicado,
    marcaPorOrganizacaoLigada: modulos.includes("marca_por_organizacao"),
    logoDefinido: Boolean(marca?.logo_path),
    followupAtivo,
    membrosAtivos,
  };
}

export async function carregarPrimeirosPassos(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<PrimeirosPassos> {
  return primeirosPassos(await carregarDadosDosPrimeirosPassos(admin, organizationId, userId));
}
