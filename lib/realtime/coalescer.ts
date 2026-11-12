/**
 * O AGRUPADOR DE RAJADAS DO REALTIME — por chave, com janela e teto.
 *
 * Uma mensagem que chega produz vários eventos (o INSERT em `messages` e várias
 * escritas em `conversations`), e cada evento invalidava uma query na hora.
 * Numa caixa movimentada a rajada de eventos virava rajada de GET em
 * `/api/v1`, cada um passando pelo proxy e pelo Supabase — a causa
 * multiplicadora do 429 `over_request_rate_limit` de 11/11/2026.
 *
 * Regras, por chave:
 *  - `janelaMs`: a execução sai `janelaMs` depois do ÚLTIMO evento (debounce);
 *  - `tetoMs`: nunca mais que `tetoMs` depois do PRIMEIRO evento pendente — uma
 *    rajada contínua não adia a tela para sempre;
 *  - `imediato`: o primeiro evento de uma rajada executa NA HORA (a mensagem
 *    nova aparece sem esperar a janela); os seguintes viram UMA execução no fim.
 *    Depois de executar, a chave fica em resfriamento por `janelaMs`: o evento
 *    que chega logo em seguida espera em vez de disparar outra execução.
 *  - `encerrar()` cancela tudo e devolve as chaves que estavam pendentes, para
 *    quem chama decidir o que fazer com elas (ex.: só marcar como velhas).
 *
 * Puro, sem React: quem usa em componente é `useInvalidacaoAgrupada`.
 */
export interface OpcoesDoAgrupador {
  janelaMs: number;
  tetoMs: number;
  imediato?: boolean;
}

export interface Agrupador<C> {
  pedir(id: string, carga: C): void;
  encerrar(): C[];
}

interface Estado<C> {
  carga: C;
  pendente: boolean;
  /** Instante do primeiro evento pendente desde a última execução. */
  primeiroPendente: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function criarAgrupador<C>(
  opcoes: OpcoesDoAgrupador,
  executar: (carga: C) => void,
): Agrupador<C> {
  const { janelaMs, imediato = false } = opcoes;
  const tetoMs = Math.max(opcoes.tetoMs, janelaMs);
  const estados = new Map<string, Estado<C>>();

  const programar = (id: string, estado: Estado<C>, agora: number) => {
    if (estado.timer) clearTimeout(estado.timer);
    let espera = janelaMs;
    if (estado.pendente && estado.primeiroPendente !== null) {
      espera = Math.min(janelaMs, estado.primeiroPendente + tetoMs - agora);
    }
    estado.timer = setTimeout(() => disparar(id), Math.max(0, espera));
  };

  const disparar = (id: string) => {
    const estado = estados.get(id);
    if (!estado) return;
    estado.timer = null;
    if (!estado.pendente) {
      estados.delete(id);
      return;
    }
    estado.pendente = false;
    estado.primeiroPendente = null;
    executar(estado.carga);
    // Resfriamento: o próximo evento logo depois espera a janela.
    programar(id, estado, Date.now());
  };

  return {
    pedir(id, carga) {
      const agora = Date.now();
      const estado = estados.get(id);
      if (!estado) {
        const novo: Estado<C> = {
          carga,
          pendente: !imediato,
          primeiroPendente: imediato ? null : agora,
          timer: null,
        };
        estados.set(id, novo);
        if (imediato) executar(carga);
        programar(id, novo, agora);
        return;
      }
      estado.carga = carga;
      if (!estado.pendente) {
        estado.pendente = true;
        estado.primeiroPendente = agora;
      }
      programar(id, estado, agora);
    },
    encerrar() {
      const pendentes: C[] = [];
      for (const estado of estados.values()) {
        if (estado.timer) clearTimeout(estado.timer);
        if (estado.pendente) pendentes.push(estado.carga);
      }
      estados.clear();
      return pendentes;
    },
  };
}

/** Mensagens da conversa aberta: a primeira sai na hora; o resto da rajada, junto. */
export const AGRUPAR_MENSAGENS: OpcoesDoAgrupador = { janelaMs: 300, tetoMs: 1000, imediato: true };
/** Painéis ao lado da conversa (passagens, participantes, notas): podem esperar a rajada. */
export const AGRUPAR_PAINEL: OpcoesDoAgrupador = { janelaMs: 500, tetoMs: 1500 };
/** Inbox do admin da plataforma: escuta TODAS as organizações, a rajada é maior. */
export const AGRUPAR_ADMIN: OpcoesDoAgrupador = { janelaMs: 800, tetoMs: 3000 };
