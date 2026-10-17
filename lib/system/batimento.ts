/**
 * Batimento dos serviços de fundo (worker e scheduler), migration 0961.
 *
 * Este módulo é PURO de propósito: não importa `env`, Supabase nem o logger do
 * app. O worker (processo `tsx`, fala `pg` puro) e as rotas do Next usam as
 * mesmas regras de idade e de ritmo sem arrastar para dentro do worker o que só
 * o app tem. Quem toca o banco do lado do app mora em `batimento-app.ts`.
 *
 * ─── Por que o batimento é amarrado ao laço, e não a um `setInterval` ────────
 * Um timer próprio continua disparando com o laço principal travado: o worker
 * "bateria" vivo enquanto não consome nada. O batedor abaixo só ESCREVE quando
 * alguém o chama (`tocar`), e quem o chama é a volta do laço da fila. Laço
 * travado, batimento parado, monitor externo avisa.
 */

export const SERVICOS_DE_FUNDO = ["worker", "scheduler"] as const;
export type ServicoDeFundo = (typeof SERVICOS_DE_FUNDO)[number];

/** Ritmo do batimento. O laço pode girar mais rápido; a escrita não. */
export const INTERVALO_DO_BATIMENTO_MS = 30_000;

/**
 * Idade máxima do último batimento para o serviço contar como vivo. Seis
 * batimentos perdidos: um deploy que reinicia o serviço ou um blip do banco não
 * acende o monitor, uma queda de verdade acende em até 3 minutos.
 */
export const LIMITE_DE_IDADE_SEGUNDOS: Record<ServicoDeFundo, number> = {
  worker: 180,
  scheduler: 180,
};

export type MotivoDoBatimento = "sem_batimento" | "batimento_atrasado" | "leitura_indisponivel";

export interface EstadoDoBatimento {
  status: "ok" | "down";
  ultimo_batimento_em: string | null;
  segundos_desde: number | null;
  motivo?: MotivoDoBatimento;
}

/**
 * Julga a idade de um batimento. Nunca lança: valor ausente ou ilegível é
 * "sem batimento", e relógio adiantado (batimento no futuro) conta como idade 0
 * em vez de negativa.
 */
export function avaliarBatimento(
  servico: ServicoDeFundo,
  ultimoEm: string | Date | null | undefined,
  agoraMs: number = Date.now(),
): EstadoDoBatimento {
  const instante = ultimoEm == null ? Number.NaN : new Date(ultimoEm).getTime();
  if (!Number.isFinite(instante)) {
    return { status: "down", ultimo_batimento_em: null, segundos_desde: null, motivo: "sem_batimento" };
  }
  const segundos = Math.max(0, Math.round((agoraMs - instante) / 1000));
  const ultimo = new Date(instante).toISOString();
  if (segundos > LIMITE_DE_IDADE_SEGUNDOS[servico]) {
    return { status: "down", ultimo_batimento_em: ultimo, segundos_desde: segundos, motivo: "batimento_atrasado" };
  }
  return { status: "ok", ultimo_batimento_em: ultimo, segundos_desde: segundos };
}

export interface OpcoesDoBatedor {
  /** A escrita em si. Rejeitar é permitido: o batedor trata. */
  gravar: () => Promise<unknown>;
  aoFalhar?: (err: unknown) => void;
  intervaloMs?: number;
  agora?: () => number;
}

/**
 * Devolve `tocar()`: síncrono, barato, seguro de chamar a cada volta do laço.
 * Grava no máximo uma vez por `intervaloMs`, nunca duas escritas ao mesmo tempo,
 * e uma escrita pendurada não trava o batedor para sempre (passados dois
 * intervalos uma nova tentativa sai). Falha de escrita não derruba nem atrasa o
 * laço: vai para `aoFalhar` e a próxima tentativa é daqui a um intervalo.
 */
export function criarBatedor(opcoes: OpcoesDoBatedor): { tocar: () => void } {
  const intervalo = opcoes.intervaloMs ?? INTERVALO_DO_BATIMENTO_MS;
  const agora = opcoes.agora ?? Date.now;
  let ultimaTentativa = Number.NEGATIVE_INFINITY;
  let emVooDesde: number | null = null;

  return {
    tocar() {
      const t = agora();
      if (t - ultimaTentativa < intervalo) return;
      if (emVooDesde !== null && t - emVooDesde < intervalo * 2) return;
      ultimaTentativa = t;
      emVooDesde = t;
      let escrita: Promise<unknown>;
      try {
        escrita = Promise.resolve(opcoes.gravar());
      } catch (err) {
        emVooDesde = null;
        opcoes.aoFalhar?.(err);
        return;
      }
      escrita
        .catch((err: unknown) => opcoes.aoFalhar?.(err))
        .finally(() => {
          emVooDesde = null;
        });
    },
  };
}

/** O mínimo que o batimento pede de um pool/cliente `pg`. */
export interface ConsultaPg {
  query: (texto: string, valores?: unknown[]) => Promise<unknown>;
}

/**
 * A escrita do worker. O instante vem do relógio do BANCO (`now()`), não do
 * processo: o worker e o banco não precisam concordar de hora.
 */
export function gravarBatimentoPg(
  db: ConsultaPg,
  servico: ServicoDeFundo,
  versao: string | null,
  detalhe: Record<string, unknown> = {},
): Promise<unknown> {
  return db.query(
    `insert into public.sistema_batimentos (servico, ultimo_em, versao, detalhe)
     values ($1, now(), $2, $3::jsonb)
     on conflict (servico) do update
       set ultimo_em = excluded.ultimo_em, versao = excluded.versao, detalhe = excluded.detalhe`,
    [servico, versao, JSON.stringify(detalhe)],
  );
}
