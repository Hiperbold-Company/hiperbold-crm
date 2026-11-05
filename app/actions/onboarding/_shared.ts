/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session). The body may only CHOOSE among the user's own memberships —
 * validated here, against the same operant-org rule as `resolveActiveOrg` —
 * never name an arbitrary org id.
 */
import { invalidarOrg } from "@/lib/auth/cache-curto";
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, type ActiveOrg } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { precisaPagarAntesDeConfigurar } from "@/lib/onboarding/precisa-pagar";
import { ehOperante } from "@/lib/organizacao/operante";
import { redirect } from "next/navigation";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "mfa_required"
      | "not_found"
      | "payment_required"
      | "db_error"
      | "org_ja_configurada",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

/**
 * O onboarding é ato de ADMINISTRADOR, em organização AINDA NÃO concluída.
 *
 * As actions daqui escrevem com service role (renomeiam a empresa, mudam o
 * fuso, religam o agente padrão, aplicam o quadro de funil e assinam convites),
 * então o portão tem que ser o da própria action: server action é endpoint
 * público, e o id dela está no bundle do formulário. Antes só a sessão e a
 * organização ativa eram conferidas, e um viewer convidado chegava a virar
 * admin pelo convite do passo "equipe" (D-089, D-090).
 *
 *  1. papel `admin` na organização ativa;
 *  2. `mfaEmDivida()`: sessão aal1 de quem TEM fator não conduz o onboarding;
 *  3. `onboarded_at` nulo: depois de concluído, nenhuma delas roda de novo.
 *     `permitirConcluido` existe só para `finishOnboarding`, que é idempotente
 *     de propósito (segundo clique cai no redirect) e continua exigindo admin.
 *  4. Hiperbold (15/10/2026): o cliente novo paga ANTES de configurar. Enquanto o passo "Plano"
 *     exige pagamento (`precisaPagarAntesDeConfigurar`, a mesma noção do layout de /app), nenhuma
 *     action de configuração roda — o id de cada uma está no bundle da página, então digitar a URL
 *     de um passo ou chamar a action direto não pula o pagamento. `acceptWelcome` (o passo 1, que
 *     vem ANTES do pagamento) passa `semGuardaDePlano`. Fail-open como o resto do billing.
 */
export interface OpcoesDoOnboarding {
  permitirConcluido?: boolean;
  semGuardaDePlano?: boolean;
  /**
   * A organização para a qual a ABA foi aberta (`organization_id` do formulário).
   * Só é aceita se for uma membership real do usuário; as mesmas guardas de
   * papel, MFA, conclusão e pagamento valem para ela.
   */
  orgIdDaAba?: string;
}

export async function requireOnboardingCtx(
  arg: OpcoesDoOnboarding | string | undefined = {},
): Promise<OnboardingCtx> {
  // `string` é a assinatura do upstream (`requireOnboardingCtx(orgIdDaAba)`).
  const opts: OpcoesDoOnboarding = typeof arg === "string" ? { orgIdDaAba: arg } : (arg ?? {});
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  if (supportWriteError(user.support)) throw new OnboardingError("forbidden", "Acompanhamento somente leitura ou encerrado.");

  // A aba de boas-vindas foi aberta para UMA organização. Trocar de org ativa
  // em outra aba (o cookie `active_org`) NÃO pode redirecionar este submit
  // para a organização errada: o id vem da própria aba e só é aceito se for
  // uma membership REAL do usuário. Um id arbitrário do corpo jamais alcança
  // o `.eq("id", …)` do UPDATE — sem membership ele é RECUSADO (cair na org
  // ativa seria o próprio #2068 por outra porta).
  let activeOrg: { orgId: string; name: string; role: ActiveOrg["role"] } | null;
  if (opts.orgIdDaAba) {
    const membro = user.organizations.find((o) => o.organization_id === opts.orgIdDaAba);
    // Acompanhamento (suporte) não tem membership e cairia aqui — mas o layout
    // do onboarding já expulsa essas sessões (`app/onboarding/layout.tsx`,
    // `if (user.support) redirect(...)`), então a recusa não corta o suporte.
    // Se aquele redirect sair, o teste "acompanhamento ... é recusado" mostra.
    if (!membro) {
      throw new OnboardingError("forbidden", "A organização desta aba não está mais entre os seus vínculos.");
    }
    // A mesma régua do `resolveActiveOrg`: org não operante não recebe
    // escrita — este caminho não passa por ele, então repete o portão.
    if (!ehOperante(membro.org_status)) redirect("/account-suspended");
    activeOrg = { orgId: membro.organization_id, name: membro.organization_name, role: membro.role };
  } else {
    activeOrg = await resolveActiveOrg(user);
  }
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    throw new OnboardingError("forbidden", "Só um administrador conduz o onboarding.");
  }
  if (await mfaEmDivida()) {
    throw new OnboardingError("mfa_required", "Confirme a verificação em duas etapas.");
  }
  const { onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt && !opts.permitirConcluido) {
    throw new OnboardingError("forbidden", "O onboarding desta organização já foi concluído.");
  }
  if (!onboardedAt && !opts.semGuardaDePlano && (await precisaPagarAntesDeConfigurar(createAdminClient(), activeOrg.orgId))) {
    throw new OnboardingError("payment_required", "Confirme o pagamento do plano antes de configurar.");
  }
  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
  /**
   * `soNoWizard`: grava só se a organização ainda NÃO terminou o onboarding
   * e recusa com `org_ja_configurada` caso contrário. Só as boas-vindas pedem
   * isso (#2113). Os outros passos já tiveram efeito fora daqui (agente
   * publicado, convite enviado, quadro aplicado) e precisam registrar o passo
   * mesmo numa aba antiga — recusar ali deixaria o efeito sem estado,
   * auditoria nem evento.
   */
  opcoes?: { soNoWizard?: boolean },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  // #3696: nome e fuso da empresa viajam no snapshot de cada membro; o cabeçalho
  // do passo seguinte lê dali. `finally`: a escrita condicional abaixo tem três saídas.
  try {
    await gravarPatchDoOnboarding(admin, orgId, state, patch, extra, opcoes);
  } finally {
    invalidarOrg(orgId);
  }
}

async function gravarPatchDoOnboarding(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  state: OnboardingState,
  patch: Partial<OnboardingState>,
  extra: { display_name?: string; timezone?: string } | undefined,
  opcoes: { soNoWizard?: boolean } | undefined,
): Promise<void> {
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  if (!opcoes?.soNoWizard) {
    const { error } = await admin.from("organizations").update(update).eq("id", orgId);
    if (error) throw new OnboardingError("db_error", error.message);
    return;
  }
  // #2113: a aba de boas-vindas pode ficar aberta enquanto o onboarding é
  // concluído em OUTRA aba. Sem esta condição, o submit regravava
  // `display_name` e `onboarding_state` numa organização já configurada.
  // O `.is("onboarded_at", null)` faz a escrita só na organização que ainda
  // está no wizard; o `.select("id")` devolve as linhas afetadas (PostgREST),
  // e zero linhas quer dizer "alguém terminou antes" — aí NÃO se grava nada.
  const { data, error } = await admin
    .from("organizations")
    .update(update)
    .eq("id", orgId)
    .is("onboarded_at", null)
    .select("id");
  if (error) throw new OnboardingError("db_error", error.message);
  // Com `.select("id")` o contrato do PostgREST é um ARRAY de linhas afetadas:
  // `[]` = nenhuma bateu no filtro (org já configurada, ou finalizada entre a
  // releitura e a escrita). Um array vazio é a única resposta que significa
  // "zero linhas" — `data` nulo vem de dublê que não simula o `select`.
  if (Array.isArray(data) && data.length === 0) {
    throw new OnboardingError("org_ja_configurada", "Organização já configurada.");
  }
}
