"use server";

/**
 * A compra pelo PRÓPRIO CLIENTE, atrás da chave: fase F5, Tarefa 15
 * (`hiperbold/planos/fase-F5-tarefas.md`). Três ações da tela `/app/settings/
 * plano` (Tarefa 20, fora desta tarefa): assinar um plano (cartão ou Pix
 * semestral e anual), comprar um pacote de tokens, e cancelar a assinatura Asaas ativa.
 *
 * ─── Organização SEMPRE da sessão, nunca da entrada (decisão 17) ──────────
 *
 * Nenhum dos três `input` abaixo tem `organizationId`: `resolveActiveOrg`
 * (`lib/auth/server.ts`) é a ÚNICA fonte, o mesmo molde de
 * `apagarDadosOperacionaisDaOrganizacao.ts`. `createAdminClient()` BYPASSA
 * RLS; é o `organizationId` da sessão, passado para `iniciarCompra`/
 * `cancelarAssinaturaDoCliente`, que mantém cada leitura e escrita dentro da
 * organização de quem chamou.
 *
 * ─── Só o papel `admin` da organização compra e cancela (N41) ─────────────
 *
 * `ROLE_RANK[activeOrg.role] < ROLE_RANK.admin` recusa antes de qualquer
 * outra checagem (mesma ordem de `apagarDadosOperacionaisDaOrganizacao.ts`:
 * sessão, depois papel, só depois o resto). `supportWriteError` barra sessão
 * de suporte em modo só-leitura ou encerrada. Correção 7: o admin da
 * PLATAFORMA (`authUser.is_platform_admin`) pode bypassar o papel do tenant,
 * mas só depois de provar escopo `full` em `platform_admins` e MFA em dia
 * (`mfaEmDivida`), a mesma régua de `cobrancaAsaas.ts`
 * (`requirePlatformAdmin` + `mfaEmDivida`); sem isso, comprar ou cancelar em
 * QUALQUER organização ficaria ao alcance de um escopo de suporte só
 * leitura, ou de uma sessão sem MFA provado.
 *
 * MFA em TODA ação com efeito de cobrança (auditoria de 17/10/2026): `iniciarAssinatura`, `comprarPacote`,
 * `cancelarAssinatura` e `trocarFormaDePagamento` recusam (`MENSAGEM_MFA`) quando `mfaEmDivida()` é verdadeiro,
 * para o admin do tenant também, não só para o da plataforma. `mfaEmDivida` só vale para quem JÁ cadastrou um
 * fator, então o cliente novo que compra no onboarding segue sem obstáculo. `simularCupom` não cobra e fica fora.
 *
 * ─── As duas chaves da decisão 18 ──────────────────────────────────────────
 *
 * Comprar (`iniciarAssinatura`/`comprarPacote`) exige `ASAAS_ENABLED=true`
 * (`configDoAsaas().habilitado`) E `billing_settings.compra_pelo_cliente`
 * (`compraLigada`) ao mesmo tempo. Cancelar (`cancelarAssinatura`) exige só
 * `ASAAS_ENABLED`: desligar a VENDA não pode prender ninguém numa assinatura
 * já contratada (decisão 18, plano da fase). `fn_billing_criar_pedido`
 * confere a chave do banco de novo (defesa em profundidade); esta ação
 * confere ANTES para nunca montar um cliente Asaas nem gastar uma leitura à
 * toa quando a resposta já é conhecida.
 *
 * ─── Frase fixa, nunca erro cru (risco 13) ─────────────────────────────────
 *
 * `iniciarCompra`/`cancelarAssinaturaDoCliente` (`lib/billing/asaas/
 * compra.ts`) já devolvem só mensagens fixas (nunca o texto do Postgres nem
 * do Asaas); esta ação REPASSA esse resultado sem alterar a mensagem. As
 * únicas mensagens que este arquivo cria são as do próprio gate (sessão,
 * papel, zod, as duas chaves): todas constantes, nunca construídas com o
 * erro.
 *
 * ─── Auditoria sem dado sensível ───────────────────────────────────────────
 *
 * `billing.order_created`/`billing.subscription_cancel_requested`
 * (acrescentadas ao FIM de `lib/audit/actions.ts`, nunca reordenado) só
 * disparam quando o resultado NÃO é `"erro"` (uma tentativa recusada não
 * deixa rastro de "pedido criado"). O `metadata` nunca carrega
 * `pagador` (nome/CPF/CNPJ/e-mail/celular, decisão 16 da fase) nem
 * `amountCents`: só o código do plano/pacote, o ciclo, o método e o tipo do
 * resultado (`redirecionar`/`pix`), a mesma régua de "nunca a nota livre" que
 * `assinaturaDaOrganizacao.ts` já segue para dado do cliente.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { compraLigada, configDoAsaas, type ConfigAsaas } from "@/lib/billing/asaas/config";
import {
  cancelarAssinaturaDoCliente,
  cancelarPedidoAbertoDoCliente,
  iniciarCompra,
  type EntradaIniciarCompra,
  type ResultadoCancelarAssinatura,
  type ResultadoCancelarPedidoAberto,
  type ResultadoIniciarCompra,
} from "@/lib/billing/asaas/compra";
import {
  FORMATO_DO_CODIGO_DE_CUPOM,
  MENSAGEM_CUPOM_INVALIDO,
  MENSAGEM_CUPOM_TENTATIVAS,
  simularCupom as simularCupomNoBanco,
  type ResultadoSimularCupom,
} from "@/lib/billing/asaas/cupom";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import { MOTIVOS_DE_CANCELAMENTO, TAMANHO_MAXIMO_DO_DETALHE } from "@/lib/billing/reembolso/motivos";
import { pixDisponivel } from "@/lib/billing/asaas/pix";
import { MENSAGEM_PIX_INDISPONIVEL } from "@/lib/billing/asaas/pix-mensagem";
import { urlDeRetornoDoCartao } from "@/lib/billing/asaas/retorno-do-cartao";
import { criarAvisoDeCancelamentoSobre } from "@/lib/email/conta-e-cobranca/gatilhos-de-conta";
import { supportWriteError } from "@/lib/impersonate/support";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { erroDoDocumento } from "@/lib/documentos/cpf-cnpj";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { precisaPagarAntesDeConfigurar } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Mensagens fixas do GATE (nunca do banco/Asaas) ────────────────────────

const MENSAGEM_SEM_PERMISSAO_COMPRAR = "Você não tem permissão para comprar planos desta organização.";
const MENSAGEM_SEM_PERMISSAO_CANCELAR = "Você não tem permissão para cancelar a assinatura desta organização.";
const MENSAGEM_SEM_ORGANIZACAO = "Nenhuma organização ativa nesta sessão.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos. Confira o formulário e tente de novo.";
const MENSAGEM_COMPRA_DESLIGADA = "A compra pela tela ainda não está disponível. Fale com o suporte.";
const MENSAGEM_CANCELAMENTO_DESLIGADO =
  "O cancelamento pela tela não está disponível no momento. Fale com o suporte.";
const MENSAGEM_ERRO_CONFIGURACAO =
  "Não foi possível concluir a operação agora. Tente novamente em instantes ou fale com o suporte.";
const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_MOTIVO_DO_CANCELAMENTO = "Diga por que está cancelando para continuar.";
const MENSAGEM_TERMOS_NAO_ACEITOS = "Aceite os Termos de Uso para continuar.";
const MENSAGEM_SEM_PERMISSAO_TROCAR_PAGAMENTO =
  "Você não tem permissão para trocar a forma de pagamento desta organização.";
const MENSAGEM_TROCAS_DEMAIS = "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.";
const MENSAGEM_TERMOS_ATUALIZADOS =
  "Os Termos de Uso foram atualizados. Recarregue a página e aceite de novo para continuar.";

// ─── Entrada (zod): nunca organizationId, nunca preço/plano resolvido ─────

/** Mesmo formato de `billing_plans.code`/`billing_token_pacotes.codigo` (migrações 0904/0908). */
const CODIGO = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, "código inválido");

const CHAVE = z.string().uuid("chave inválida");

/**
 * Cupom de desconto (0955): só o CÓDIGO que o cliente digitou. Vazio vira ausente; o formato é o do banco
 * (letras, números, hífen e sublinhado, 3 a 40). Sem diferença de maiúsculas e minúsculas: quem compara é o banco.
 */
const CUPOM = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().regex(FORMATO_DO_CODIGO_DE_CUPOM, "cupom inválido").optional(),
);

/**
 * Teto de tentativas de cupom por usuário (e por IP): sem ele a simulação e a compra serviriam para adivinhar
 * códigos. Janela de 10 minutos.
 */
const LIMITE_DE_TENTATIVAS_DE_CUPOM = { ip: 60, id: 20, windowSec: 600 };
/** O mesmo teto somado por ORGANIZAÇÃO: vários usuários da mesma empresa não multiplicam as tentativas. */
const LIMITE_DE_TENTATIVAS_DE_CUPOM_POR_ORGANIZACAO = { ip: 60, id: 40, windowSec: 600 };

/** `true` = barrar. Conta a tentativa por usuário e IP, e por organização (identificador hasheado nas chaves). */
async function tentativasDeCupomEsgotadas(userId: string, orgId: string): Promise<boolean> {
  if (await authRateLimited("cupom", userId, LIMITE_DE_TENTATIVAS_DE_CUPOM)) return true;
  return authRateLimited("cupom_org", orgId, LIMITE_DE_TENTATIVAS_DE_CUPOM_POR_ORGANIZACAO);
}

const PAGADOR = z.object({
  nome: z.string().trim().min(1).max(200),
  // Dígito verificador no servidor, com a MESMA função pura do formulário (`lib/documentos/cpf-cnpj.ts`).
  documento: z
    .string()
    .trim()
    .max(20)
    .refine((v) => erroDoDocumento(v) === null, { message: "CPF ou CNPJ inválido" }),
  email: z.string().trim().email().max(200).optional(),
  celular: z.string().trim().min(8).max(20).optional(),
});

const entradaIniciarAssinatura = z.object({
  planCode: CODIGO,
  ciclo: z.enum(["monthly", "semiannual", "yearly"]),
  metodo: z.enum(["CREDIT_CARD", "PIX"]),
  chave: CHAVE,
  // D-177: em quantas parcelas pagar (só cartão, semestral e anual). O navegador manda só o número: o
  // total com juros é calculado no servidor e conferido pelo banco.
  parcelas: z.number().int().min(1).max(12).optional(),
  pagador: PAGADOR.optional(),
  // D-133: a versão dos Termos que a tela mostrou ao aceite. Opcional no schema só para a recusa ter
  // frase própria (`conferirAceiteDosTermos`).
  termosVersao: z.string().max(40).optional(),
  // 0955: o código do cupom de desconto, se o cliente digitou um.
  cupom: CUPOM,
});

const entradaSimularCupom = z.object({
  codigo: z.string().trim().regex(FORMATO_DO_CODIGO_DE_CUPOM, "cupom inválido"),
  planCode: CODIGO,
  ciclo: z.enum(["monthly", "semiannual", "yearly"]),
  metodo: z.enum(["CREDIT_CARD", "PIX"]),
  parcelas: z.number().int().min(1).max(12).optional(),
});

const entradaComprarPacote = z.object({
  // `fn_billing_criar_pedido` (migração 0909) casa `p_pacote` contra
  // `billing_token_pacotes.codigo`, não o `id`: mesmo formato de `CODIGO`.
  pacote: CODIGO,
  metodo: z.enum(["CREDIT_CARD", "PIX"]),
  chave: CHAVE,
  pagador: PAGADOR.optional(),
  termosVersao: z.string().max(40).optional(),
});

/**
 * O motivo do cancelamento (migration 0957, pesquisa de cancelamento): obrigatório, de um vocabulário fechado,
 * com um texto livre opcional. Nunca organizationId: a organização é a da sessão.
 */
const entradaCancelarAssinatura = z.object({
  motivo: z.enum(MOTIVOS_DE_CANCELAMENTO),
  detalhe: z.string().trim().max(TAMANHO_MAXIMO_DO_DETALHE).optional(),
});

export type EntradaAcaoIniciarAssinatura = z.infer<typeof entradaIniciarAssinatura>;
export type EntradaAcaoSimularCupom = z.infer<typeof entradaSimularCupom>;
export type EntradaAcaoComprarPacote = z.infer<typeof entradaComprarPacote>;

// ─── Contexto da requisição, mesmo molde de assinaturaDaOrganizacao.ts ────

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

// ─── Sessão: organização ativa + papel admin (mesmo molde de
// apagarDadosOperacionaisDaOrganizacao.ts) ─────────────────────────────────

type Autorizacao = { ok: true; userId: string; orgId: string } | { ok: false; mensagem: string };

/**
 * `efeitoDeCobranca` (padrão `true`): a ação mexe em cobrança (compra, cancelamento, troca de forma de pagamento) e,
 * por isso, quem JÁ tem fator de verificação em duas etapas precisa tê-lo provado nesta sessão (`mfaEmDivida`),
 * seja o admin do tenant ou o da plataforma. Quem não cadastrou fator não é afetado (o cliente novo que compra no
 * onboarding não tem fator). Só `simularCupom`, que não gera cobrança, passa `false`; o admin da PLATAFORMA que
 * bypassa o papel prova a MFA sempre.
 */
async function autorizarAdminDaOrganizacao(
  mensagemSemPermissao: string,
  opcoes: { efeitoDeCobranca?: boolean } = {},
): Promise<Autorizacao> {
  const efeitoDeCobranca = opcoes.efeitoDeCobranca ?? true;
  let bypassDaPlataforma = false;
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, mensagem: mensagemSemPermissao };
  if (supportWriteError(authUser.support)) return { ok: false, mensagem: mensagemSemPermissao };

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, mensagem: MENSAGEM_SEM_ORGANIZACAO };

  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    if (!authUser.is_platform_admin) {
      return { ok: false, mensagem: mensagemSemPermissao };
    }
    // Correção 7: bypass do papel do tenant pelo admin da PLATAFORMA exige
    // escopo `full` e MFA em dia, a mesma régua de `cobrancaAsaas.ts`
    // (`requirePlatformAdmin` + `mfaEmDivida`). Sem isso, um platform admin
    // com escopo de suporte só leitura, ou numa sessão sem MFA provado,
    // compraria ou cancelaria a assinatura de QUALQUER organização.
    const admin = createAdminClient();
    const { data: paRow, error: paErro } = await admin
      .from("platform_admins")
      .select("scope")
      .eq("user_id", authUser.id)
      .is("revoked_at", null)
      .maybeSingle();
    if (paErro || !paRow || paRow.scope !== "full") {
      return { ok: false, mensagem: mensagemSemPermissao };
    }
    bypassDaPlataforma = true;
  }

  // MFA para TODO ator que causa efeito de cobrança (não só o admin da plataforma): uma sessão de admin do tenant
  // roubada (aal1, com fator cadastrado) não compra, não cancela nem troca a forma de pagamento.
  if ((efeitoDeCobranca || bypassDaPlataforma) && (await mfaEmDivida())) {
    return { ok: false, mensagem: MENSAGEM_MFA };
  }

  return { ok: true, userId: authUser.id, orgId: activeOrg.orgId };
}

/**
 * `configDoAsaas()` lança `ErroConfiguracaoAsaas` quando `ASAAS_ENABLED=true`
 * mas a base/chave estão incoerentes (`lib/billing/asaas/config.ts`): isto é
 * um erro de CONFIGURAÇÃO do servidor, não algo que o cliente causou, então
 * vira log + a mesma mensagem genérica, nunca o texto da exceção.
 */
function configAsaasOuNulo(): ConfigAsaas | null {
  try {
    return configDoAsaas();
  } catch (err) {
    logger.error("[compraDoPlano] configuração do Asaas inválida", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function montarDeps(
  config: ConfigAsaas,
  admin: ReturnType<typeof createAdminClient>,
  urlDeRetornoDoCartao?: string,
) {
  return {
    db: dbCompraSupabase(admin),
    asaas: criarClienteAsaas({ fetch: globalThis.fetch.bind(globalThis), config, logger }),
    config,
    logger,
    // COB-07: o e-mail de cancelamento confirmado (só é chamado pelo cancelamento; compra ignora).
    avisoDeCancelamento: criarAvisoDeCancelamentoSobre(admin),
    // Cartão na fatura hospedada: o Asaas devolve o cliente ao app depois de pagar (só assinatura de plano).
    ...(urlDeRetornoDoCartao ? { urlDeRetornoDoCartao } : {}),
  };
}

/**
 * D-133: a compra só segue com o aceite da versão VIGENTE dos Termos. Sem versão: pede o aceite. Versão
 * diferente da vigente (a página ficou aberta enquanto o texto mudou): pede para recarregar e aceitar o
 * texto novo. A versão gravada é sempre a constante do servidor, nunca texto vindo do navegador.
 */
function conferirAceiteDosTermos(versaoEnviada: string | undefined): string | null {
  if (!versaoEnviada) return MENSAGEM_TERMOS_NAO_ACEITOS;
  if (versaoEnviada !== VERSAO_DOS_TERMOS) return MENSAGEM_TERMOS_ATUALIZADOS;
  return null;
}

async function auditarPedido(
  actorId: string,
  orgId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.order_created",
    actorUserId: actorId,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    metadata,
    requestId,
    ip,
    userAgent,
  });
}

// ─── iniciarAssinatura ──────────────────────────────────────────────────────

export async function iniciarAssinatura(input: {
  planCode: string;
  ciclo: "monthly" | "semiannual" | "yearly";
  metodo: "CREDIT_CARD" | "PIX";
  chave: string;
  parcelas?: number;
  pagador?: { nome: string; documento: string; email?: string; celular?: string };
  termosVersao?: string;
  /** 0955: o código do cupom de desconto digitado pelo cliente (opcional). */
  cupom?: string;
}): Promise<ResultadoIniciarCompra> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_COMPRAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaIniciarAssinatura.safeParse(input);
  if (!parsed.success) {
    // Cupom mal formado tem frase própria; qualquer outro defeito segue a frase genérica.
    const soOCupomFalhou = parsed.error.issues.every((i) => i.path[0] === "cupom");
    return { tipo: "erro", mensagem: soOCupomFalhou ? MENSAGEM_CUPOM_INVALIDO : MENSAGEM_DADOS_INVALIDOS };
  }
  const recusaDosTermos = conferirAceiteDosTermos(parsed.data.termosVersao);
  if (recusaDosTermos) return { tipo: "erro", mensagem: recusaDosTermos };
  if (parsed.data.cupom && (await tentativasDeCupomEsgotadas(auth.userId, auth.orgId))) {
    return { tipo: "erro", mensagem: MENSAGEM_CUPOM_TENTATIVAS };
  }

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const admin = createAdminClient();
  if (!(await compraLigada(admin, config.habilitado))) {
    return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };
  }

  // Conta Asaas sem chave Pix ativa: o POST do Pix falharia. Recusa ANTES de criar pedido ou chamar o Asaas.
  if (parsed.data.metodo === "PIX" && !(await pixDisponivel())) {
    return { tipo: "erro", mensagem: MENSAGEM_PIX_INDISPONIVEL };
  }

  const entrada: EntradaIniciarCompra = {
    organizationId: auth.orgId,
    actorId: auth.userId,
    tipo: "assinatura",
    planCode: parsed.data.planCode,
    ciclo: parsed.data.ciclo,
    metodo: parsed.data.metodo,
    chave: parsed.data.chave,
    parcelas: parsed.data.parcelas ?? 1,
    pagador: parsed.data.pagador,
    termosVersao: VERSAO_DOS_TERMOS,
    ...(parsed.data.cupom ? { cupom: parsed.data.cupom } : {}),
  };

  // Quem ainda está no passo de pagamento do onboarding volta para ele; quem já usa o CRM, para o plano.
  const pagandoNoOnboarding = await precisaPagarAntesDeConfigurar(admin, auth.orgId);
  const resultado = await iniciarCompra(
    montarDeps(config, admin, urlDeRetornoDoCartao(env.NEXT_PUBLIC_APP_URL, pagandoNoOnboarding)),
    entrada,
  );

  if (resultado.tipo !== "erro") {
    await auditarPedido(auth.userId, auth.orgId, {
      termos_versao: VERSAO_DOS_TERMOS,
      tipo: "assinatura",
      plan_code: parsed.data.planCode,
      ciclo: parsed.data.ciclo,
      parcelas: parsed.data.parcelas ?? 1,
      metodo: parsed.data.metodo,
      resultado: resultado.tipo,
      // 0955: só o código e o desconto, nunca dado do pagador.
      ...(resultado.cupom ? { cupom: resultado.cupom.codigo, desconto_cents: resultado.cupom.descontoCents } : {}),
    });
  }

  return resultado;
}

// ─── simularCupom ───────────────────────────────────────────────────────────

/**
 * 0955: mostra o valor com o cupom antes de o cliente confirmar. Só leitura (`fn_billing_cupom_simular`), no
 * mesmo gate de `iniciarAssinatura` (sessão, papel admin, as duas chaves da compra), com teto de tentativas
 * por usuário para ninguém adivinhar códigos. O preço e o desconto vêm do banco; a resposta nunca devolve
 * o estado interno do cupom (limite, validade, lista de planos), só o resultado desta simulação.
 */
export async function simularCupom(input: {
  codigo: string;
  planCode: string;
  ciclo: "monthly" | "semiannual" | "yearly";
  metodo: "CREDIT_CARD" | "PIX";
  parcelas?: number;
}): Promise<ResultadoSimularCupom> {
  // Simular não gera cobrança: não exige a MFA provada (o admin da plataforma exige sempre).
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_COMPRAR, { efeitoDeCobranca: false });
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaSimularCupom.safeParse(input);
  if (!parsed.success) {
    const soOCodigoFalhou = parsed.error.issues.every((i) => i.path[0] === "codigo");
    return { tipo: "erro", mensagem: soOCodigoFalhou ? MENSAGEM_CUPOM_INVALIDO : MENSAGEM_DADOS_INVALIDOS };
  }

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const admin = createAdminClient();
  if (!(await compraLigada(admin, config.habilitado))) {
    return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };
  }

  if (await tentativasDeCupomEsgotadas(auth.userId, auth.orgId)) {
    return { tipo: "erro", mensagem: MENSAGEM_CUPOM_TENTATIVAS };
  }

  return simularCupomNoBanco(dbCompraSupabase(admin), {
    organizationId: auth.orgId,
    codigo: parsed.data.codigo,
    planCode: parsed.data.planCode,
    ciclo: parsed.data.ciclo,
    metodo: parsed.data.metodo,
    parcelas: parsed.data.parcelas ?? 1,
  });
}

// ─── comprarPacote ──────────────────────────────────────────────────────────

export async function comprarPacote(input: {
  pacote: string;
  metodo: "CREDIT_CARD" | "PIX";
  chave: string;
  pagador?: { nome: string; documento: string; email?: string; celular?: string };
  termosVersao?: string;
}): Promise<ResultadoIniciarCompra> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_COMPRAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaComprarPacote.safeParse(input);
  if (!parsed.success) return { tipo: "erro", mensagem: MENSAGEM_DADOS_INVALIDOS };
  const recusaDosTermos = conferirAceiteDosTermos(parsed.data.termosVersao);
  if (recusaDosTermos) return { tipo: "erro", mensagem: recusaDosTermos };

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const admin = createAdminClient();
  if (!(await compraLigada(admin, config.habilitado))) {
    return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };
  }

  // Conta Asaas sem chave Pix ativa: o POST do Pix falharia. Recusa ANTES de criar pedido ou chamar o Asaas.
  if (parsed.data.metodo === "PIX" && !(await pixDisponivel())) {
    return { tipo: "erro", mensagem: MENSAGEM_PIX_INDISPONIVEL };
  }

  const entrada: EntradaIniciarCompra = {
    organizationId: auth.orgId,
    actorId: auth.userId,
    tipo: "pacote_tokens",
    pacote: parsed.data.pacote,
    metodo: parsed.data.metodo,
    chave: parsed.data.chave,
    pagador: parsed.data.pagador,
    termosVersao: VERSAO_DOS_TERMOS,
  };

  const resultado = await iniciarCompra(montarDeps(config, admin), entrada);

  if (resultado.tipo !== "erro") {
    await auditarPedido(auth.userId, auth.orgId, {
      termos_versao: VERSAO_DOS_TERMOS,
      tipo: "pacote_tokens",
      pacote: parsed.data.pacote,
      metodo: parsed.data.metodo,
      resultado: resultado.tipo,
    });
  }

  return resultado;
}

// ─── cancelarAssinatura ─────────────────────────────────────────────────────

/**
 * Cancela a assinatura Asaas ATIVA da organização (decisão 18: depende só de
 * `ASAAS_ENABLED`, nunca de `compra_pelo_cliente`: desligar a venda não pode
 * prender ninguém numa assinatura já contratada).
 *
 * O cancelamento pede o MOTIVO (decisão do dono do produto, 15/10/2026, migration 0957): um dos cinco do
 * vocabulário fechado, obrigatório, e um texto livre opcional. O motivo só é gravado
 * (`billing_cancel_feedback`) depois de o cancelamento dar certo; a auditoria leva o código do motivo, nunca o
 * texto livre. Falha ao gravar o motivo só vai ao log: nunca desfaz o cancelamento.
 */
export async function cancelarAssinatura(input: {
  motivo: string;
  detalhe?: string;
}): Promise<ResultadoCancelarAssinatura> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_CANCELAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaCancelarAssinatura.safeParse(input);
  if (!parsed.success) return { tipo: "erro", mensagem: MENSAGEM_MOTIVO_DO_CANCELAMENTO };

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_CANCELAMENTO_DESLIGADO };

  const admin = createAdminClient();
  const resultado = await cancelarAssinaturaDoCliente(montarDeps(config, admin), auth.orgId, auth.userId);

  if (resultado.tipo === "ok") {
    try {
      const { error } = await admin.rpc("fn_billing_cancelamento_motivo_registrar" as never, {
        p_org: auth.orgId,
        p_actor: auth.userId,
        p_motivo: parsed.data.motivo,
        p_detalhe: parsed.data.detalhe ?? null,
      } as never);
      if (error) {
        logger.error("[compraDoPlano] não gravou o motivo do cancelamento", {
          codigo: (error as { code?: string }).code ?? null,
        });
      }
    } catch (err) {
      logger.error("[compraDoPlano] a gravação do motivo do cancelamento lançou", {
        erro: err instanceof Error ? err.message.slice(0, 200) : "erro",
      });
    }

    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.subscription_cancel_requested",
      actorUserId: auth.userId,
      organizationId: auth.orgId,
      resourceType: "organization",
      resourceId: auth.orgId,
      metadata: {
        cancel_at_period_end: resultado.cancelAtPeriodEnd,
        motivo: parsed.data.motivo,
        com_detalhe: Boolean(parsed.data.detalhe),
      },
      requestId,
      ip,
      userAgent,
    });
  }

  return resultado;
}

// ─── trocarFormaDePagamento ─────────────────────────────────────────────────

/** Teto de trocas por usuário (e por IP) e por organização: cada troca remove e recria cobrança no Asaas. */
const LIMITE_DE_TROCAS_DE_PAGAMENTO = { ip: 30, id: 6, windowSec: 600 };
const LIMITE_DE_TROCAS_DE_PAGAMENTO_POR_ORGANIZACAO = { ip: 30, id: 10, windowSec: 600 };

/**
 * "Trocar forma de pagamento" (passo Plano do onboarding): quem ficou preso numa tela de "aguardando" (Pix que
 * não vai pagar, cartão que não concluiu) cancela o pedido aberto, sem pagamento, para escolher de novo. A
 * remoção no Asaas e a recusa quando o pagamento já entrou estão em `cancelarPedidoAbertoDoCliente`. Só o admin
 * da organização, com teto de tentativas, e auditada. Depende só de `ASAAS_ENABLED` (como o cancelamento:
 * desligar a venda não prende ninguém num pedido). Nunca recebe id de pedido nem de organização: é o pedido
 * aberto da organização da sessão.
 */
export async function trocarFormaDePagamento(): Promise<ResultadoCancelarPedidoAberto> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_TROCAR_PAGAMENTO);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  if (
    (await authRateLimited("trocar_pagamento", auth.userId, LIMITE_DE_TROCAS_DE_PAGAMENTO)) ||
    (await authRateLimited("trocar_pagamento_org", auth.orgId, LIMITE_DE_TROCAS_DE_PAGAMENTO_POR_ORGANIZACAO))
  ) {
    return { tipo: "erro", mensagem: MENSAGEM_TROCAS_DEMAIS };
  }

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const resultado = await cancelarPedidoAbertoDoCliente(montarDeps(config, createAdminClient()), auth.orgId);

  if (resultado.tipo === "ok") {
    if (resultado.cancelou) {
      const { requestId, ip, userAgent } = await contextoDaRequisicao();
      await audit({
        action: "billing.order_payment_method_reset",
        actorUserId: auth.userId,
        organizationId: auth.orgId,
        resourceType: "organization",
        resourceId: auth.orgId,
        metadata: { tipo: "assinatura" },
        requestId,
        ip,
        userAgent,
      });
    }
    revalidatePath("/onboarding/plano");
  }

  return resultado;
}
