/**
 * O MIOLO da escrita do teto de gasto de IA — escada, piso, carência,
 * auditoria e o laço de retorno —, separado da autorização.
 *
 * Desde 25/11/2026 (decisão do dono do produto) o teto é uma TRAVA DE
 * SEGURANÇA escondida: o cliente não vê dólar e não ajusta. Quem chama esta
 * função é só `PATCH /api/v1/admin/tenants/[id]/ai-budget`, com
 * `requirePlatformAdminEscrita()` e a organização tirada do PATH. A rota da
 * empresa (`PATCH /api/v1/ai/budget`) recusa com 403 para qualquer papel.
 *
 * As regras (e o porquê de cada uma) são as que moravam na rota da empresa e
 * não mudaram; os comentários vieram junto.
 *
 * `orgId` vem SEMPRE de quem chama, de fonte confiável — nunca do corpo: o
 * esquema não tem campo de organização, e o Zod descarta chave desconhecida.
 */
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import {
  PISO_DE_TETO_CENTS,
  normalizarModoDeOrcamento,
  type ModoDeOrcamento,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** Horas de carência entre armar a parada e ela passar a valer. */
const CARENCIA_HORAS = 72;

/**
 * O piso escrito como o leitor brasileiro o lê. `toFixed(2)` devolveria
 * "US$ 1.00" — ponto decimal numa frase em português, na única linha que o
 * usuário recebe quando o salvamento é recusado. Mesmo idioma de `emDolares`
 * em `run-model-call.ts`: dólar porque `cost_cents` é USD, vírgula porque a
 * frase é pt-BR.
 */
const PISO_LEGIVEL = `US$ ${(PISO_DE_TETO_CENTS / 100).toLocaleString("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

/** A escada. Comparação por posição — nunca por igualdade de string espalhada. */
const DEGRAU: Record<ModoDeOrcamento, number> = { off: 0, avisar: 1, bloquear: 2 };

export const esquemaDoAjusteDeOrcamento = z
  .object({
    monthly_limit_cents: z.number().int().min(0).optional(),
    // 50..99 casa o CHECK `ai_budgets_alarm_threshold_pct_check` do banco. O Zod
    // aceitava 1..100: 30 ou 100 passavam aqui, batiam no 23514 e viravam
    // "Erro ao atualizar orçamento." 500 — sem dizer qual campo ofendeu, e com o
    // rollback otimista do hook desfazendo a mudança na tela, o que se lê como
    // "o app engoliu meu clique". Não relaxo o CHECK: a régua mais estrita é a
    // certa; a errada era a visível.
    alarm_threshold_pct: z.number().int().min(50).max(99).optional(),
    enforcement_mode: z.enum(["off", "avisar", "bloquear"]).optional(),
    /** Renuncia à carência ao armar. Sozinho não é mutação — ver o refine. */
    confirmar_imediato: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.monthly_limit_cents !== undefined ||
      v.alarm_threshold_pct !== undefined ||
      v.enforcement_mode !== undefined,
    { message: "Informe ao menos um campo: teto, limiar ou modo." },
  );

export interface AjusteDeOrcamento {
  /** A organização alvo, de fonte confiável (path do admin). */
  orgId: string;
  actorUserId: string;
  /** O corpo cru da requisição; validado aqui. */
  body: unknown;
  idioma: Idioma;
  requestId: string;
  /** Grava `acting_as_platform_admin`/`bypassed_rls` na auditoria. */
  comoAdminDaPlataforma: boolean;
}

/** Valida, aplica e audita o ajuste. Devolve a resposta HTTP pronta. */
export async function ajustarOrcamentoDeIa(d: AjusteDeOrcamento): Promise<Response> {
  const t = (texto: string) => traduzir(texto, d.idioma);
  const parsed = esquemaDoAjusteDeOrcamento.safeParse(d.body);
  if (!parsed.success) {
    return fail("validation_failed", t("Payload inválido."), 422, {
      requestId: d.requestId,
      details: parsed.error.flatten(),
    });
  }
  const dados = parsed.data;

  const admin = createAdminClient();

  const { data: existing, error: readErr } = await admin
    .from("ai_budgets")
    .select("monthly_limit_cents, alarm_threshold_pct, enforcement_mode, enforcement_effective_at")
    .eq("organization_id", d.orgId)
    .maybeSingle();
  if (readErr) {
    logger.error("ai-budget: leitura do estado atual falhou", {
      organization_id: d.orgId,
      request_id: d.requestId,
      causa: readErr.message,
    });
    return fail("internal_error", t("Erro ao ler o orçamento."), 500, { requestId: d.requestId });
  }

  const modoAntes = normalizarModoDeOrcamento(existing?.enforcement_mode ?? null);
  // Sem linha, o teto de ANTES é 0 ("sem teto") e não o `DEFAULT 5000` da
  // coluna: 5000 é o valor que ninguém escolheu, e tratá-lo como escolha aqui
  // recriaria, na porta de escrita, exatamente a confusão que a 0159 desfez.
  const tetoAntes = Number(existing?.monthly_limit_cents ?? 0);
  const limiarAntes = Number(existing?.alarm_threshold_pct ?? 80);

  const modoDepois = dados.enforcement_mode ?? modoAntes;
  const tetoDepois = dados.monthly_limit_cents ?? tetoAntes;
  const limiarDepois = dados.alarm_threshold_pct ?? limiarAntes;

  const armando = modoDepois === "bloquear" && modoAntes !== "bloquear";

  if (armando && modoAntes === "off") {
    // ⚠️ A REGRA É DE ESTADO, NÃO DE TEMPO — e o texto já afirmou o contrário.
    // Ele dizia "deixe-a um tempo em Me avisar", mas o servidor só exige que o
    // modo atual não seja `off`: salvar "Me avisar", reabrir o diálogo e salvar
    // "Parar a IA" leva ~15 segundos, e com "Começar a valer agora" marcado a
    // parada é imediata. Rótulo visível é contrato; prometer uma janela que o
    // código não garante é a classe de defeito que esta entrega existe para
    // matar. Quem garante o tempo é a CARÊNCIA de 72h, e é dela que a frase fala.
    return fail(
      "invalid_state_transition",
      t('Antes de fazer a IA parar no limite, salve "Me avisar" — assim o aviso já ') +
        t("está de pé quando a parada começar a valer, 72 horas depois de você armá-la."),
      422,
      { requestId: d.requestId, details: { de: modoAntes, para: modoDepois, degrau_faltante: "avisar" } },
    );
  }

  // ⚠️ O PISO GUARDA `avisar` TAMBÉM, e não só `bloquear`. Quando ele guardava
  // só a parada, `avisar` com teto 0 era alcançável pela tela e pela API — e o
  // efeito não era inofensivo: a CTE `avisa` de `SQL_ORCAMENTO` dispara com
  // `gasto >= teto * limiar / 100`, que com teto 0 é `gasto >= 0`, SEMPRE
  // verdadeiro já na primeira chamada, e a CTE `retrata` exigia `gasto < 0` para
  // fechar. Aviso permanente e falso na Central, no caminho de primeira impressão
  // (organização nova cai em `monthly_limit_cents: 0`, o campo pré-preenche
  // "0.00", e o radio "Me avisar" nasce habilitado). O tell estava no próprio
  // título da opção: "Me avisar ao passar de 80% de US$ 0,00" — avisar de quê?
  // Quem quer acompanhar sem limite escolhe "Só acompanhar" (`off`), que é o
  // estado que existe exatamente para isso.
  if (modoDepois !== "off" && tetoDepois < PISO_DE_TETO_CENTS) {
    return fail(
      "unprocessable_entity",
      `Para avisar ou parar no limite, o limite precisa ser de pelo menos ${PISO_LEGIVEL} por mês. ` +
        'Se você só quer acompanhar o gasto sem limite, escolha "Só acompanhar".',
      422,
      {
        requestId: d.requestId,
        details: { piso_cents: PISO_DE_TETO_CENTS, teto_cents: tetoDepois, modo: modoDepois },
      },
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (dados.monthly_limit_cents !== undefined) {
    patch.monthly_limit_cents = dados.monthly_limit_cents;
  }
  if (dados.alarm_threshold_pct !== undefined) {
    patch.alarm_threshold_pct = dados.alarm_threshold_pct;
  }
  if (dados.enforcement_mode !== undefined) {
    patch.enforcement_mode = dados.enforcement_mode;
  }
  // `enforcement_effective_at` só é escrito na TRANSIÇÃO para `bloquear`. Rearmar
  // devolve a carência inteira (afrouxa, direção certa); mexer no teto de quem já
  // está armado não a devolve — senão bastaria salvar o diálogo para adiar por
  // mais 72h uma parada que já vale.
  const efetivoEm = armando
    ? new Date(
        Date.now() + (dados.confirmar_imediato ? 0 : CARENCIA_HORAS * 60 * 60 * 1000),
      ).toISOString()
    : null;
  const desarmando = modoAntes === "bloquear" && modoDepois !== "bloquear";
  if (armando) patch.enforcement_effective_at = efetivoEm;
  // ⚠️ DESARMAR ZERA A DATA. Sem esta linha, uma organização que armou (efetivo
  // em T) e voltou para `off`/`avisar` ficava com um `enforcement_effective_at`
  // NO PASSADO e o modo desarmado: a carência ficava PRÉ-GASTA, e qualquer
  // escritor que pusesse `enforcement_mode='bloquear'` sem tocar na data armaria
  // um bloqueio válido NO ATO, sem as 72h. O comentário da própria coluna diz
  // que `null` é o estado de repouso de uma linha desarmada — a partir do
  // primeiro desarme isso deixava de valer, e nada restaurava o invariante.
  if (desarmando) patch.enforcement_effective_at = null;

  if (existing) {
    const { error: updErr } = await admin
      .from("ai_budgets")
      .update(patch)
      .eq("organization_id", d.orgId);
    if (updErr) {
      logger.error("ai-budget: update falhou", {
        organization_id: d.orgId,
        request_id: d.requestId,
        causa: updErr.message,
      });
      return fail("internal_error", t("Erro ao atualizar orçamento."), 500, { requestId: d.requestId });
    }
  } else {
    const { error: insErr } = await admin.from("ai_budgets").insert({
      organization_id: d.orgId,
      // Explícito, e nunca o `DEFAULT 5000` da coluna: a linha nasce aqui de uma
      // decisão humana, e "não disse teto" significa SEM teto, não US$ 50.
      monthly_limit_cents: tetoDepois,
      ...patch,
    });
    if (insErr) {
      logger.error("ai-budget: insert falhou", {
        organization_id: d.orgId,
        request_id: d.requestId,
        causa: insErr.message,
      });
      return fail("internal_error", t("Erro ao criar orçamento."), 500, { requestId: d.requestId });
    }
  }

  void audit({
    // Uma mutação = uma linha. A transição para/de `bloquear` escolhe o código
    // (é a pergunta que alguém vai querer filtrar sozinha: "quem armou/desarmou
    // a parada?"); todo o resto cai em `limit_changed`, e o metadata carrega
    // antes/depois dos três campos em qualquer um dos casos.
    action: armando
      ? "ai.budget_enforcement_armed"
      : desarmando
        ? "ai.budget_enforcement_disarmed"
        : "ai.budget_limit_changed",
    actorUserId: d.actorUserId,
    actingAsPlatformAdmin: d.comoAdminDaPlataforma,
    bypassedRls: d.comoAdminDaPlataforma,
    organizationId: d.orgId,
    resourceType: "ai_budgets",
    resourceId: d.orgId,
    requestId: d.requestId,
    metadata: {
      enforcement_mode: { antes: modoAntes, depois: modoDepois },
      monthly_limit_cents: { antes: tetoAntes, depois: tetoDepois },
      alarm_threshold_pct: { antes: limiarAntes, depois: limiarDepois },
      ...(armando
        ? {
            enforcement_effective_at: efetivoEm,
            confirmar_imediato: dados.confirmar_imediato === true,
          }
        : {}),
    },
  });

  const status = await getBudgetStatus(d.orgId);
  const retratados = await retratarAvisos({
    admin,
    orgId: d.orgId,
    requestId: d.requestId,
    afrouxou:
      DEGRAU[modoDepois] < DEGRAU[modoAntes] ||
      status.current_month_consumed_cents < limiarDeAlerta(status),
  });

  // Fechar aqui e devolver `blocked_now: true` faria a tela contradizer o clique
  // que o usuário acabou de dar.
  return ok(retratados ? { ...status, blocked_now: false } : status, { requestId: d.requestId });
}

/** O gasto a partir do qual o aviso abre. Sem teto ⇒ não há limiar a cruzar. */
function limiarDeAlerta(status: BudgetStatus): number {
  if (status.monthly_limit_cents <= 0) return Number.POSITIVE_INFINITY;
  return (status.monthly_limit_cents * status.alarm_threshold_pct) / 100;
}

/**
 * O LAÇO DE RETORNO (invariante 7) do lado da tela.
 *
 * O gate se retrata sozinho na chamada seguinte (a CTE `retrata` de
 * `SQL_ORCAMENTO`) — mas "a chamada seguinte" pode não existir justamente
 * quando ela mais importa: se a IA está parada, ninguém a chama, e o alerta
 * crítico ficaria aceso para sempre. Quem afrouxa pela tela fecha os itens na
 * hora, sem cron e sem esperar tráfego.
 *
 * Falhar aqui não desfaz o afrouxamento: o teto já mudou no banco, e devolver
 * erro por causa de um aviso não fechado faria a pessoa clicar de novo achando
 * que nada aconteceu.
 */
async function retratarAvisos(d: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  requestId: string;
  afrouxou: boolean;
}): Promise<boolean> {
  if (!d.afrouxou) return false;
  const { data, error } = await d.admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", d.orgId)
    .in("kind", ["budget_exceeded", "budget_warning"])
    // Só os itens do orçamento da ORG e o legado sem referência (gravado antes
    // de o insert ter ref). O do teto do PLANO não é afrouxado por esta tela.
    .or("ref_kind.is.null,ref_kind.eq.ai_budget")
    .eq("status", "open")
    .select("id");
  if (error) {
    logger.warn("ai-budget: avisos de orçamento não puderam ser retratados", {
      organization_id: d.orgId,
      request_id: d.requestId,
      causa: error.message,
    });
    return false;
  }
  return (data?.length ?? 0) > 0;
}
