import "server-only";

/**
 * O Pix está disponível para vender? Só quando a conta Asaas tem pelo menos UMA chave Pix ATIVA: sem ela o
 * `POST /payments` com `billingType: PIX` volta 4xx de validação e o cliente via só "não foi possível
 * concluir a compra". Conta nova, ainda em aprovação, está nesse caso; o cartão segue funcionando.
 *
 * Descoberto sozinho, sem interruptor: `GET /pix/addressKeys?status=ACTIVE` (só leitura), `totalCount > 0`.
 * Quando a chave ativar, o Pix volta sozinho na próxima renovação do cache.
 *
 * Cache em memória POR PROCESSO: 10 minutos com resposta, 1 minuto depois de erro (tenta de novo logo).
 * Erro ou tempo esgotado devolve o último valor conhecido e, sem nenhum, `false` (esconder o Pix é o lado
 * seguro: o cartão continua). Um aviso por renovação com erro, sem segredo (só o tipo do erro).
 * Compra desligada (`ASAAS_ENABLED=false`) devolve `false` sem chamar a rede.
 */
import { contarChavesPixAtivas, type DepsClienteAsaas } from "./cliente";
import { configDoAsaas } from "./config";
import { ErroAsaasException } from "./erros";
import { logger as loggerDaApp } from "@/lib/logger";

export const TTL_PIX_MS = 10 * 60_000;
export const TTL_PIX_ERRO_MS = 60_000;

interface EntradaDoCache {
  valor: boolean;
  expiraEm: number;
}

export interface DepsPix {
  /** Injetável nos testes; por padrão resolve a configuração real e o `fetch` global. */
  deps?: Pick<DepsClienteAsaas, "fetch" | "config" | "logger">;
  agora?: () => number;
}

let cache: EntradaDoCache | null = null;
/** Último valor que veio de uma resposta de verdade (nunca de um erro). */
let ultimoConhecido: boolean | null = null;
let emVoo: Promise<boolean> | null = null;

/** Só para teste. */
export function esquecerCacheDoPix(): void {
  cache = null;
  ultimoConhecido = null;
  emVoo = null;
}

function resolverDeps(dados?: DepsPix["deps"]): Pick<DepsClienteAsaas, "fetch" | "config" | "logger"> {
  if (dados) return dados;
  return { fetch: globalThis.fetch.bind(globalThis), config: configDoAsaas(), logger: loggerDaApp };
}

async function renovar(opcoes: DepsPix, agora: () => number): Promise<boolean> {
  try {
    const deps = resolverDeps(opcoes.deps);
    if (!deps.config.habilitado) return false;
    const total = await contarChavesPixAtivas(deps);
    const valor = total > 0;
    ultimoConhecido = valor;
    cache = { valor, expiraEm: agora() + TTL_PIX_MS };
    return valor;
  } catch (err) {
    const valor = ultimoConhecido ?? false;
    cache = { valor, expiraEm: agora() + TTL_PIX_ERRO_MS };
    // Só o tipo do erro: nunca a chave, o cabeçalho nem o corpo.
    const tipo = err instanceof ErroAsaasException ? err.erro.tipo : err instanceof Error ? err.name : "desconhecido";
    loggerDaApp.warn("asaas_pix_disponivel_falhou", { tipo, usando: valor });
    return valor;
  }
}

export async function pixDisponivel(opcoes: DepsPix = {}): Promise<boolean> {
  const agora = opcoes.agora ?? Date.now;
  if (cache && cache.expiraEm > agora()) return cache.valor;
  // Várias telas ao mesmo tempo compartilham UMA consulta.
  if (!emVoo) {
    emVoo = renovar(opcoes, agora).finally(() => {
      emVoo = null;
    });
  }
  return emVoo;
}
