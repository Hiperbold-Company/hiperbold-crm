/**
 * Reconectar uma conexão que JÁ EXISTE: o aparelho saiu (o servidor diz
 * "desconectado") e o cliente lê um QR novo na MESMA instância.
 *
 * ─── O que este caminho NUNCA faz ───────────────────────────────────────────
 *
 * Diferente do pareamento novo (`./pareamento`), aqui a instância é do cliente
 * e tem histórico amarrado: conversas, acesso da IA, números de teste. Então:
 *  - não apaga a instância no servidor nem arquiva a linha, nem quando o QR
 *    expira (QR expirado = o cliente gera outro);
 *  - não cria instância, não reserva vaga do plano, não usa o token de
 *    ADMINISTRADOR da instalação. Só o token DA INSTÂNCIA, guardado cifrado na
 *    própria linha, e só para o endereço gravado nela (com a régua de destino de
 *    `fetchParaDestinoDaOrganizacao`, dentro de `pedirConexao`/`lerInstancia`).
 *
 * ─── A linha é sempre da organização da sessão ──────────────────────────────
 *
 * Toda leitura e escrita filtra `organization_id` (o de quem está autenticado,
 * nunca do corpo), o provider e `archived_at is null`. Pareamento ainda pendente
 * não é conexão (é do fluxo novo) e responde 404, igual a um id de outra
 * organização.
 *
 * ─── Concluir não briga com o webhook nem com o vigia ───────────────────────
 *
 * O evento `connection` do servidor não grava `status` na linha: ele só fecha o
 * aviso da Central (`sincronizarSaudeDaConexao`, origem "empurrão"). Quem grava
 * `status` é a varredura de saúde, de 5 em 5 minutos. Aqui o status vira
 * `WORKING` na hora, com escrita CONDICIONAL (só a linha que ainda não estava
 * `WORKING` muda, e só essa chamada audita), e o aviso é fechado pelo mesmo
 * caminho do empurrão: a leitura é do `/instance/status`, o mesmo vocabulário
 * do evento, e fala do número. Se o evento chegar depois, ele não acha nada
 * aberto e não muda nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import { nomeDoCanal } from "../estado";
import { sincronizarSaudeDaConexao } from "../health";
import {
  enderecoNaoAlcancavel,
  gravarWebhookDaConexao,
  registrarWebhookUazapi,
} from "./conexao";
import { lerInstancia, pedirConexao, type InstanciaLida } from "./pareamento";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FRASE_SERVIDOR_FORA =
  "Não foi possível falar com o servidor de WhatsApp. Tente de novo em instantes.";
const FRASE_SERVIDOR_FORA_AGORA =
  "Não foi possível falar com o servidor de WhatsApp agora. Tente de novo em instantes.";

export type CodigoDeFalhaDaReconexao =
  | "not_found"
  | "state_conflict"
  | "invalid_request"
  | "internal_error"
  | "upstream_unavailable";

export interface FalhaDaReconexao {
  ok: false;
  status: 404 | 409 | 422 | 500 | 502;
  codigo: CodigoDeFalhaDaReconexao;
  /** Frase fixa em português; nunca resposta do servidor. */
  reason: string;
}

const falha = (
  status: FalhaDaReconexao["status"],
  codigo: CodigoDeFalhaDaReconexao,
  reason: string,
): FalhaDaReconexao => ({ ok: false, status, codigo, reason });

export interface ReconexaoAguardando {
  id: string;
  /** `expirado`: o servidor parou de esperar a leitura. Nada foi apagado; basta gerar outro. */
  estado: "aguardando" | "expirado";
  /** Data URL da imagem do QR, ou `null` enquanto o servidor ainda não a gerou. */
  qr: string | null;
  /** Código de pareamento (quando o cliente informou o número). */
  codigo: string | null;
}

export interface ReconexaoConcluida {
  id: string;
  estado: "conectado";
  conexao: { id: string; displayName: string; phoneNumber: string | null; status: string };
  webhook: { registrado: boolean; aviso: string | null };
  /** O aparelho que conectou tem OUTRO número que o gravado antes: a tela avisa. */
  numeroMudou: boolean;
  /** `true` só na chamada que de fato mudou a linha para `WORKING` (a que deve gerar o audit). */
  concluiuAgora: boolean;
}

export type EstadoDaReconexao = ReconexaoAguardando | ReconexaoConcluida;

interface LinhaDaReconexao {
  id: string;
  organization_id: string;
  status: string | null;
  display_name: string | null;
  phone_number: string | null;
  uazapi_base_url: string | null;
  uazapi_token_encrypted: unknown;
  webhook_path_token: string | null;
  pareamento_qr_estado: string | null;
}

const COLUNAS =
  "id, organization_id, status, display_name, phone_number, uazapi_base_url, uazapi_token_encrypted, webhook_path_token, pareamento_qr_estado";

async function acharConexao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<LinhaDaReconexao | null> {
  if (!UUID.test(id) || !UUID.test(organizationId)) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`reconexao_achar_conexao_falhou: ${error.code ?? ""}`.trim());
  const linha = (data as LinhaDaReconexao | null) ?? null;
  // Pareamento ainda não lido não é conexão: é do fluxo novo, que tem prazo e limpeza próprios.
  if (!linha || linha.pareamento_qr_estado === "pendente") return null;
  return linha;
}

/** O token e o endereço da instância, ou a falha que a tela mostra. */
async function acessoDaInstancia(
  admin: SupabaseClient,
  linha: LinhaDaReconexao,
): Promise<{ baseUrl: string; token: string } | FalhaDaReconexao> {
  const cifrado = typeof linha.uazapi_token_encrypted === "string" ? linha.uazapi_token_encrypted : "";
  const token = cifrado ? await decryptWebhookSecret(admin, cifrado).catch(() => null) : null;
  if (!token || !linha.uazapi_base_url) {
    return falha(
      409,
      "state_conflict",
      "Esta conexão não tem o acesso ao servidor guardado. Conecte de novo pelo modo avançado, com o mesmo token.",
    );
  }
  return { baseUrl: linha.uazapi_base_url, token };
}

const aparado = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");
const soDigitos = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");

function validarTelefone(bruto: string | null | undefined): string | null | FalhaDaReconexao {
  const telefone = soDigitos(bruto) || null;
  if (telefone && !/^\d{10,15}$/.test(telefone)) {
    return falha(422, "invalid_request", "Informe o número com DDI e DDD, só dígitos.");
  }
  return telefone;
}

const ehFalha = (v: unknown): v is FalhaDaReconexao =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

/**
 * Gera (ou renova) o QR, ou o código com o número, na MESMA instância.
 *
 * Antes de pedir, pergunta ao servidor: se o número já voltou sozinho, conclui
 * sem pedir QR nenhum (pedir conexão a uma instância conectada não serve a nada).
 */
export async function iniciarReconexao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    id: string;
    telefone?: string | null;
    /** Monta a URL pública de entrega a partir do token de caminho; `null` sem endereço público. */
    urlDoWebhook: ((pathToken: string) => string) | null;
  },
): Promise<EstadoDaReconexao | FalhaDaReconexao> {
  const linha = await acharConexao(admin, input.organizationId, input.id);
  if (!linha) return falha(404, "not_found", "Conexão não encontrada.");

  const telefone = validarTelefone(input.telefone);
  if (ehFalha(telefone)) return telefone;

  const acesso = await acessoDaInstancia(admin, linha);
  if (ehFalha(acesso)) return acesso;

  // Falha fechado: sem saber o estado, não pede conexão (poderia bater numa instância conectada).
  const antes = await lerInstancia(acesso.baseUrl, acesso.token);
  if (!antes) return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA_AGORA);
  if (antes.estado === "connected") {
    return concluir(admin, linha, acesso, antes, input.urlDoWebhook);
  }

  const conexao = await pedirConexao(acesso.baseUrl, acesso.token, telefone);
  if (!conexao.ok) return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);
  return { id: linha.id, estado: "aguardando", qr: conexao.qr, codigo: conexao.codigo };
}

/**
 * O estado da reconexão: aguardando (com o QR atualizado), expirado ou
 * conectado. Quando conectou, conclui. Quando expirou, NÃO desfaz nada.
 */
export async function verificarReconexao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    id: string;
    urlDoWebhook: ((pathToken: string) => string) | null;
  },
): Promise<EstadoDaReconexao | FalhaDaReconexao> {
  const linha = await acharConexao(admin, input.organizationId, input.id);
  if (!linha) return falha(404, "not_found", "Conexão não encontrada.");

  const acesso = await acessoDaInstancia(admin, linha);
  if (ehFalha(acesso)) return acesso;

  const lida = await lerInstancia(acesso.baseUrl, acesso.token);
  if (!lida) return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);

  if (lida.estado === "connected") {
    return concluir(admin, linha, acesso, lida, input.urlDoWebhook);
  }
  // Logo depois do pedido o servidor ainda pode dizer "desconectado": a tela tem
  // a carência dela e segue perguntando. Aqui só se traduz o que o servidor disse.
  const parado = lida.estado === "disconnected" || lida.estado === "hibernated";
  return {
    id: linha.id,
    estado: parado ? "expirado" : "aguardando",
    qr: parado ? null : lida.qr,
    codigo: parado ? null : lida.codigo,
  };
}

async function concluir(
  admin: SupabaseClient,
  linha: LinhaDaReconexao,
  acesso: { baseUrl: string; token: string },
  lida: InstanciaLida,
  urlDoWebhook: ((pathToken: string) => string) | null,
): Promise<ReconexaoConcluida | FalhaDaReconexao> {
  const numeroAnterior = soDigitos(linha.phone_number);
  const numeroNovo = soDigitos(lida.telefone);
  const numeroMudou = !!numeroAnterior && !!numeroNovo && numeroAnterior !== numeroNovo;
  const telefoneFinal = lida.telefone ?? linha.phone_number;
  // O apelido que o cliente deu à conexão fica: o nome do perfil só entra quando não há apelido.
  const apelidoAtual = aparado(linha.display_name);
  const nome = apelidoAtual || lida.perfil || nomeDoCanal({ display_name: null, phone_number: telefoneFinal });

  const patch: Record<string, unknown> = {
    status: "WORKING",
    last_status_change_at: new Date().toISOString(),
    phone_number: telefoneFinal,
    ...(apelidoAtual ? {} : { display_name: nome }),
  };
  // CONDICIONAL: só a linha que ainda não estava WORKING muda. Duas abas (ou a aba e a
  // varredura) concluindo juntas: só uma audita.
  let consulta = admin
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .is("archived_at", null);
  consulta = linha.status === null ? consulta.is("status", null) : consulta.neq("status", "WORKING");
  const { data: mudadas, error } = await consulta.select("id");
  if (error) return falhaDaGravacao(error);
  const concluiuAgora = Array.isArray(mudadas) && mudadas.length > 0;

  if (!concluiuAgora && numeroNovo && numeroNovo !== numeroAnterior) {
    // Outra chamada (ou a varredura) já pôs WORKING, mas o número que conectou é outro.
    const { error: erroDoNumero } = await admin
      .from("channel_sessions")
      .update({ phone_number: telefoneFinal })
      .eq("organization_id", linha.organization_id)
      .eq("id", linha.id)
      .is("archived_at", null);
    if (erroDoNumero) return falhaDaGravacao(erroDoNumero);
  }

  // A volta das mensagens: confere (e, se faltar, registra) o NOSSO webhook. Idempotente:
  // o registro acha o webhook com a mesma URL e não duplica.
  let registrado = false;
  let aviso: string | null = null;
  const url = urlDoWebhook && linha.webhook_path_token ? urlDoWebhook(linha.webhook_path_token) : null;
  if (!url || enderecoNaoAlcancavel(url)) {
    aviso =
      "O endereço público do CRM não está configurado. A conexão foi gravada e envia, mas as mensagens não vão chegar até o endereço ser público.";
  } else {
    const reg = await registrarWebhookUazapi({ baseUrl: acesso.baseUrl, token: acesso.token, url });
    if (reg.ok) {
      registrado = !!reg.webhookId;
      await gravarWebhookDaConexao(admin, linha.organization_id, linha.id, reg.webhookId);
    } else {
      aviso = reg.reason;
    }
  }

  // Fecha o aviso da Central e a faixa de "desconectado" sem esperar a varredura.
  try {
    await sincronizarSaudeDaConexao(
      admin,
      { id: linha.id, organization_id: linha.organization_id, status: "WORKING", phone_number: telefoneFinal },
      { reachable: true, status: "WORKING", detail: null },
      nome,
      "empurrao",
    );
  } catch (erro) {
    logger.warn("[reconexao] o aviso de conexão não foi fechado; a varredura fecha depois", {
      detail: erro instanceof Error ? erro.message : "erro",
    });
  }

  return {
    id: linha.id,
    estado: "conectado",
    conexao: { id: linha.id, displayName: nome, phoneNumber: telefoneFinal, status: "WORKING" },
    webhook: { registrado, aviso },
    numeroMudou,
    concluiuAgora,
  };
}

function falhaDaGravacao(error: { code?: string; message?: string }): FalhaDaReconexao {
  if (error.code === "23505") {
    // O índice de número único por empresa: este número já está em OUTRA conexão ativa daqui.
    // Nada é desfeito: a instância e a linha ficam como estão.
    return falha(
      409,
      "state_conflict",
      "Este número já está em outra conexão desta empresa. Remova uma das duas e tente de novo.",
    );
  }
  logger.error("[reconexao] a conexão não foi gravada", { code: error.code ?? "sem_codigo" });
  return falha(500, "internal_error", "Conectou, mas não foi possível gravar a conexão. Tente de novo.");
}
