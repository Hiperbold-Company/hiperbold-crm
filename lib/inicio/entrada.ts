/**
 * Para onde `/app` leva quem entra: o Início ou a home de sempre (Inbox).
 *
 * Decisão do dono do produto em 15/10/2026: com a compra pelo cliente ligada, depois de pago o CRM
 * abre no Início enquanto algum passo OBRIGATÓRIO faltar; feitos os obrigatórios, abre no Inbox. O
 * Início continua no menu para sempre. Compra desligada (instalação própria, CI): nada muda.
 *
 * Função pura. A ordem com "sem plano vai para assinar" é decidida por quem chama: aquele redirect
 * vem ANTES desta pergunta.
 */
import { ROLE_RANK, type Role } from "@/lib/auth/types";

export const CAMINHO_DO_INICIO = "/app/inicio";

export interface EntradaParaDecidir {
  compraLigada: boolean;
  /** Papel na organização ativa. `null` = sem papel resolvido. */
  papel: Role | null;
  /** Sessão de suporte (somente leitura): nunca é desviada do que pediu. */
  suporte: boolean;
  obrigatoriosFaltando: number;
}

/** Só quem administra a empresa recebe o Início: os passos são tarefa de admin. */
export function papelRecebeOInicio(papel: Role | null): boolean {
  return papel !== null && ROLE_RANK[papel] >= ROLE_RANK.admin;
}

export function entrarNoInicio(entrada: EntradaParaDecidir): boolean {
  if (!entrada.compraLigada) return false;
  if (entrada.suporte) return false;
  if (!papelRecebeOInicio(entrada.papel)) return false;
  return entrada.obrigatoriosFaltando > 0;
}
