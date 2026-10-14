"use server";

/**
 * As três ações do admin da PLATAFORMA sobre os cupons de desconto (migration 0955, fork Hiperbold): criar,
 * ativar ou desativar e listar. O mesmo gate de `cobrancaAsaas.ts`: `requirePlatformAdmin`, escopo `full` e
 * MFA em dia (`mfaEmDivida`). Cupom é preço, então o suporte só leitura não mexe.
 *
 * A regra mora no banco (`fn_billing_cupom_criar`, `fn_billing_cupom_definir_ativo`, `fn_billing_cupom_listar`,
 * todas só service_role): aqui só se valida a forma da entrada, se traduz o código de erro para uma frase fixa
 * (o texto cru do Postgres nunca sai daqui) e se audita. A auditoria leva o código e as restrições do cupom,
 * nunca dado de cliente. O USO do cupom por uma organização fica em `billing.order_created`.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { FORMATO_DO_CODIGO_DE_CUPOM } from "@/lib/billing/asaas/cupom";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos.";
const MENSAGEM_GENERICA = "Não foi possível salvar. Tente de novo.";
const MENSAGEM_LEITURA = "Não foi possível carregar os cupons.";
const MENSAGEM_SEM_ESCOPO = "Seu acesso de suporte não permite mexer nos cupons.";

const CAMINHO_TELA_CUPONS = "/admin/sistema/cupons";

// ─── Entrada (zod) ──────────────────────────────────────────────────────────

const UUID = z.string().uuid();
/** Mesmo formato de `billing_plans.code` (migration 0904). */
const CODIGO_DO_PLANO = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, "código inválido");

const entradaCriarCupom = z
  .object({
    codigo: z.string().trim().regex(FORMATO_DO_CODIGO_DE_CUPOM, "código inválido"),
    tipo: z.enum(["percentual", "valor"]),
    /** Percentual (1 a 99) ou centavos (maior que zero). */
    valor: z.number().int().positive().max(100_000_000),
    planos: z.array(CODIGO_DO_PLANO).max(20).optional(),
    ciclos: z.array(z.enum(["monthly", "semiannual", "yearly"])).max(3).optional(),
    /** ISO 8601 com fuso; no futuro. */
    validoAte: z.string().datetime({ offset: true }).nullable().optional(),
    maxUsos: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
    descricao: z.string().trim().max(200).optional(),
  })
  .refine((e) => e.tipo !== "percentual" || e.valor <= 99, { message: "percentual de 1 a 99", path: ["valor"] });

const entradaDefinirCupomAtivo = z.object({
  cupomId: UUID,
  ativo: z.boolean(),
});

export type ResultadoDaAcaoDeCupom =
  | { ok: true; dados: Record<string, unknown> }
  | { ok: false; error: string };

export interface CupomListado {
  id: string;
  codigo: string;
  tipo: "percentual" | "valor";
  valor: number;
  planos: string[];
  ciclos: string[];
  valido_ate: string | null;
  max_usos: number | null;
  ativo: boolean;
  descricao: string | null;
  criado_em: string;
  /** Pedidos pagos (ou estornados) com este cupom. */
  usos_pagos: number;
  /** Pedidos abertos com este cupom nas últimas 24 horas (seguram uma vaga do limite). */
  usos_abertos: number;
}

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

/** Traduz o erro das funções SQL de cupom para a frase da tela. Código fora do vocabulário: log e frase genérica. */
function mensagemDoErroDeCupomDoAdmin(error: { code?: string; message?: string } | null): string {
  const msg = error?.message ?? "";
  if (error?.code === "22023") {
    if (msg.includes("billing_cupom_codigo_em_uso")) return "Já existe um cupom com este código.";
    if (msg.includes("billing_cupom_codigo_invalido")) {
      return "Código inválido. Use letras, números, hífen e sublinhado, de 3 a 40 caracteres.";
    }
    if (msg.includes("billing_cupom_tipo_invalido")) return "Tipo de desconto inválido.";
    if (msg.includes("billing_cupom_valor_invalido")) {
      return "Valor inválido. No percentual, de 1 a 99; em valor fixo, mais que zero.";
    }
    if (msg.includes("billing_cupom_plano_inexistente")) return "Algum dos planos informados não existe.";
    if (msg.includes("billing_cupom_ciclo_invalido")) return "Algum dos ciclos informados é inválido.";
    if (msg.includes("billing_cupom_validade_invalida")) return "A validade precisa estar no futuro.";
    if (msg.includes("billing_cupom_max_usos_invalido")) return "O limite de usos precisa ser pelo menos 1.";
    if (msg.includes("billing_cupom_descricao_longa")) return "A descrição passa de 200 caracteres.";
    if (msg.includes("billing_cupom_ativo_obrigatorio")) return "Informe se ativa ou desativa.";
  }
  if (error?.code === "P0002" && msg.includes("billing_cupom_nao_encontrado")) return "Cupom não encontrado.";
  logger.error("[cupons] erro na escrita de cupom", { code: error?.code ?? null, message: error?.message ?? null });
  return MENSAGEM_GENERICA;
}

/** Gate do admin da plataforma: escopo `full` e MFA em dia. */
async function autorizarAdminDaPlataforma(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const { user, platformAdmin } = await requirePlatformAdmin();
  if (platformAdmin.scope !== "full") return { ok: false, error: MENSAGEM_SEM_ESCOPO };
  if (await mfaEmDivida()) return { ok: false, error: MENSAGEM_MFA };
  return { ok: true, userId: user.id };
}

// ─── criarCupom ─────────────────────────────────────────────────────────────

export async function criarCupom(input: {
  codigo: string;
  tipo: "percentual" | "valor";
  valor: number;
  planos?: string[];
  ciclos?: Array<"monthly" | "semiannual" | "yearly">;
  validoAte?: string | null;
  maxUsos?: number | null;
  descricao?: string;
}): Promise<ResultadoDaAcaoDeCupom> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  const parsed = entradaCriarCupom.safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  const e = parsed.data;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_cupom_criar" as never, {
    p_codigo: e.codigo,
    p_tipo: e.tipo,
    p_valor: e.valor,
    p_planos: e.planos ?? [],
    p_ciclos: e.ciclos ?? [],
    p_valido_ate: e.validoAte ?? null,
    p_max_usos: e.maxUsos ?? null,
    p_descricao: e.descricao ?? null,
    p_actor: gate.userId,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDeCupomDoAdmin(error as { code?: string; message?: string }) };
  }

  const resultado = data as { id: string; codigo: string; tipo: string; valor: number };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.coupon_created",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    resourceType: "billing_coupon",
    resourceId: resultado.id,
    metadata: {
      codigo: resultado.codigo,
      tipo: resultado.tipo,
      valor: resultado.valor,
      planos: e.planos ?? [],
      ciclos: e.ciclos ?? [],
      valido_ate: e.validoAte ?? null,
      max_usos: e.maxUsos ?? null,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_TELA_CUPONS);
  return { ok: true, dados: resultado };
}

// ─── definirCupomAtivo ──────────────────────────────────────────────────────

export async function definirCupomAtivo(input: { cupomId: string; ativo: boolean }): Promise<ResultadoDaAcaoDeCupom> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  const parsed = entradaDefinirCupomAtivo.safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_cupom_definir_ativo" as never, {
    p_cupom: parsed.data.cupomId,
    p_ativo: parsed.data.ativo,
    p_actor: gate.userId,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDeCupomDoAdmin(error as { code?: string; message?: string }) };
  }

  const resultado = data as { id: string; codigo: string; ativo_anterior: boolean; ativo_novo: boolean };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.coupon_toggled",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    resourceType: "billing_coupon",
    resourceId: resultado.id,
    metadata: {
      codigo: resultado.codigo,
      ativo_anterior: resultado.ativo_anterior,
      ativo_novo: resultado.ativo_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_TELA_CUPONS);
  return { ok: true, dados: resultado };
}

// ─── listarCupons ───────────────────────────────────────────────────────────

/** Só leitura; sem auditoria (nada muda). Cada cupom vem com a contagem de usos pagos. */
export async function listarCupons(): Promise<{ ok: true; cupons: CupomListado[] } | { ok: false; error: string }> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_cupom_listar" as never);
  if (error) {
    logger.error("[cupons] listar falhou", { code: (error as { code?: string }).code ?? null });
    return { ok: false, error: MENSAGEM_LEITURA };
  }
  return { ok: true, cupons: (data as CupomListado[] | null) ?? [] };
}
