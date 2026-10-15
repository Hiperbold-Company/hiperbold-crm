/**
 * Perfil da empresa — "o que a empresa faz", na palavra do dono. É o MESMO dado que o passo de boas-vindas
 * do onboarding grava em `organizations.onboarding_state.welcome.o_que_faz` (`welcomeSchema`), com o
 * mesmo teto de 280 caracteres. Aqui ele ganha a tela de Configurações › Empresa que faltava: depois
 * do onboarding não havia onde corrigi-lo, e o passo "Perfil da empresa" da tela Início precisa de um
 * lugar para o cliente preenchê-lo.
 *
 * Obrigatório nesta tela (no onboarding era opcional): o passo do Início só conta como feito com o
 * texto preenchido.
 */
import { z } from "zod";

export const TAMANHO_MAXIMO_DO_QUE_FAZ = 280;

export const perfilDaEmpresaSchema = z.object({
  o_que_faz: z.string().trim().min(2).max(TAMANHO_MAXIMO_DO_QUE_FAZ),
});
export type PerfilDaEmpresaInput = z.infer<typeof perfilDaEmpresaSchema>;
