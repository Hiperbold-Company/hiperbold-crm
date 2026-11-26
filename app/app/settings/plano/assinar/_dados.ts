import "server-only";

/**
 * Leituras PRÓPRIAS da tela `/app/settings/plano/assinar` (fase F5, Tarefa
 * 20): pacotes de tokens à venda e o formulário do pagador já preenchido
 * com os dados da empresa e de quem está logado (o formulário aparece em toda
 * compra: a ficha do Asaas sempre recebe contato e endereço).
 *
 * Mesma doutrina de `lib/billing/asaas/leitura.ts` (nunca lança, degrada
 * para vazio/neutro com `leituraFalhou`): fica FORA daquele arquivo porque o
 * briefing desta tarefa não autoriza tocar em `lib/billing/asaas/*`.
 *
 * `billing_token_pacotes` não tem um `for_sale` próprio como
 * `billing_plans`: "à venda" para um pacote é `ativo = true` e
 * `preco_cents` preenchido e maior que zero (restrição fixa 3 da fase: nada
 * de preço inventado, e nada sem preço aparece para compra).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { planosParaVenda, type PlanoParaVenda } from "@/lib/billing/asaas/leitura";
import { pixDisponivel } from "@/lib/billing/asaas/pix";
import {
  opcoesDeParcelamento,
  type OpcaoDeParcelas,
  type ParametrosDeParcelamento,
} from "@/lib/billing/asaas/parcelamento";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";
import { formatarDocumento } from "@/lib/documentos/cpf-cnpj";

import type { CamposDoFormularioDoPagador } from "../_logica-compra";

export interface PacoteParaVenda {
  codigo: string;
  nome: string;
  tokens: number;
  precoCents: number;
}

export interface ResultadoPacotesParaVenda {
  pacotes: PacoteParaVenda[];
  leituraFalhou: boolean;
}

interface LinhaDoPacoteCru {
  codigo: string;
  nome: string;
  tokens: number;
  preco_cents: number;
}

function mensagemDeErro(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Pacotes ativos com preço definido, do mais barato para o mais caro. Nunca lança. */
export async function pacotesParaVenda(
  admin: SupabaseClient,
  log?: Logger,
): Promise<ResultadoPacotesParaVenda> {
  try {
    const { data, error } = await admin
      .from("billing_token_pacotes")
      .select("codigo, nome, tokens, preco_cents")
      .eq("ativo", true)
      .not("preco_cents", "is", null)
      .gt("preco_cents", 0)
      .order("preco_cents", { ascending: true });

    if (error) throw new Error(`ler billing_token_pacotes: ${error.message}`);

    const linhas = (data ?? []) as unknown as LinhaDoPacoteCru[];
    return {
      pacotes: linhas.map((l) => ({
        codigo: l.codigo,
        nome: l.nome,
        tokens: l.tokens,
        precoCents: l.preco_cents,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      etapa: "pacotes_para_venda_tela_cliente",
      erro: mensagemDeErro(err),
    });
    return { pacotes: [], leituraFalhou: true };
  }
}

/** O que se sabe de quem está comprando, para pré-preencher e-mail e celular do formulário do pagador. */
export interface QuemCompra {
  email: string | null;
  celular: string | null;
}

/**
 * O formulário do pagador já aberto com o que o CRM sabe: nome e CPF/CNPJ da empresa
 * (`organizations.legal_name` e `organizations.cnpj`, os da tela Configurações › Empresa) e e-mail e
 * celular de quem está logado. O CRM não guarda endereço da empresa: ele chega em branco e a pessoa
 * preenche. Tudo continua editável na tela. Nunca lança: na falha, só o que veio de `quemCompra`.
 */
export async function pagadorInicial(
  admin: SupabaseClient,
  organizationId: string,
  quemCompra: QuemCompra | undefined,
  log?: Logger,
): Promise<Partial<CamposDoFormularioDoPagador>> {
  const doUsuario: Partial<CamposDoFormularioDoPagador> = {
    ...(quemCompra?.email ? { email: quemCompra.email } : {}),
    ...(quemCompra?.celular ? { celular: quemCompra.celular } : {}),
  };
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("legal_name, cnpj")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw new Error(`ler organizations: ${error.message}`);
    const org = data as { legal_name: string | null; cnpj: string | null } | null;
    return {
      ...(org?.legal_name ? { nome: org.legal_name } : {}),
      ...(org?.cnpj ? { documento: formatarDocumento(org.cnpj) } : {}),
      ...doUsuario,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      etapa: "pagador_inicial_tela_cliente",
      organization_id: organizationId,
      erro: mensagemDeErro(err),
    });
    return doUsuario;
  }
}

/**
 * Os parâmetros de parcelamento de `billing_settings` (D-177): taxa mensal, até quantas parcelas sem
 * juros e os tetos do semestral e do anual. Fail-closed: se a leitura falhar, nenhum parâmetro (só o 1x
 * aparece). Nunca lança.
 */
export async function parametrosDeParcelamento(admin: SupabaseClient, log?: Logger): Promise<ParametrosDeParcelamento> {
  const vazio: ParametrosDeParcelamento = { taxaMensal: null, semJurosAte: null, maxSemestral: null, maxAnual: null };
  try {
    const { data, error } = await admin
      .from("billing_settings")
      .select("parcelamento_taxa_mensal, parcelamento_sem_juros_ate, parcelamento_max_semestral, parcelamento_max_anual")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(`ler billing_settings: ${error.message}`);
    const c = data as {
      parcelamento_taxa_mensal: number | string | null;
      parcelamento_sem_juros_ate: number | null;
      parcelamento_max_semestral: number | null;
      parcelamento_max_anual: number | null;
    } | null;
    if (!c) return vazio;
    return {
      taxaMensal: c.parcelamento_taxa_mensal == null ? null : Number(c.parcelamento_taxa_mensal),
      semJurosAte: c.parcelamento_sem_juros_ate,
      maxSemestral: c.parcelamento_max_semestral,
      maxAnual: c.parcelamento_max_anual,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", { etapa: "parametros_de_parcelamento", erro: mensagemDeErro(err) });
    return vazio;
  }
}

/** As opções de parcelamento de cada plano à venda, por ciclo: a conta é do servidor. */
export type OpcoesDeParcelasPorPlano = Record<string, { semiannual: OpcaoDeParcelas[]; yearly: OpcaoDeParcelas[] }>;

export interface DadosDaCompraDePlano {
  planos: PlanoParaVenda[];
  pacotes: PacoteParaVenda[];
  /** O formulário do pagador já preenchido com o que o CRM sabe (empresa e quem está logado). Aparece em toda compra. */
  pagadorInicial: Partial<CamposDoFormularioDoPagador>;
  leituraFalhou: boolean;
  opcoesDeParcelas: OpcoesDeParcelasPorPlano;
  taxaMensalPercentual: number | null;
  /** D-180: o plano de um contrato vivo (avaliação, ativa ou atrasada), só para marcar o cartão; senão `null`. */
  planoAtualCode: string | null;
  /** A conta Asaas tem chave Pix ativa? Sem ela a tela não oferece o Pix (só o cartão). */
  pixDisponivel: boolean;
}

/**
 * Tudo o que a compra de plano precisa ler, num lugar só: a tela `/app/settings/plano/assinar` e o
 * passo "Plano" do onboarding mostram o MESMO formulário e, por isso, leem o mesmo (antes isto
 * morava inline na página). Só planos à venda e com preço (restrição fixa 3 da fase). Nunca lança:
 * cada leitura degrada sozinha e `leituraFalhou` avisa.
 */
export async function dadosDaCompraDePlano(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
  quemCompra?: QuemCompra,
): Promise<DadosDaCompraDePlano> {
  const [planosResultado, pacotesResultado, pagador, parametros, planoDaOrg, pixAtivo] = await Promise.all([
    planosParaVenda(admin, log),
    pacotesParaVenda(admin, log),
    pagadorInicial(admin, organizationId, quemCompra, log),
    parametrosDeParcelamento(admin, log),
    planoDaOrganizacao(admin, organizationId, log),
    pixDisponivel(),
  ]);

  const planoAtualCode =
    !planoDaOrg.leituraFalhou &&
    planoDaOrg.contrato !== null &&
    ["avaliacao", "ativa", "atrasada"].includes(planoDaOrg.contrato.status)
      ? planoDaOrg.plano.code
      : null;

  const planos = planosResultado.planos.filter((p) => p.forSale && p.priceMonthlyCents > 0);

  // D-177: as opções de parcelamento são calculadas AQUI, no servidor (a conta e os parâmetros nunca vão
  // para o navegador); o cliente só mostra e escolhe o número de parcelas.
  const opcoesDeParcelas: OpcoesDeParcelasPorPlano = {};
  for (const plano of planos) {
    opcoesDeParcelas[plano.code] = {
      semiannual: plano.priceSemiannualCents ? opcoesDeParcelamento(plano.priceSemiannualCents, "semiannual", parametros) : [],
      yearly: plano.priceYearlyCents ? opcoesDeParcelamento(plano.priceYearlyCents, "yearly", parametros) : [],
    };
  }

  return {
    planos,
    pacotes: pacotesResultado.pacotes,
    pagadorInicial: pagador,
    leituraFalhou: planosResultado.leituraFalhou || pacotesResultado.leituraFalhou,
    opcoesDeParcelas,
    taxaMensalPercentual: parametros.taxaMensal === null ? null : Math.round(parametros.taxaMensal * 10000) / 100,
    planoAtualCode,
    pixDisponivel: pixAtivo,
  };
}
