/**
 * Entrada das rotas de mensagem agendada (migration 1017). A organização nunca
 * vem daqui: as rotas a tiram da sessão.
 */
import { z } from "zod";

export const modeloDaAgendadaSchema = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(16),
  values: z.record(z.string(), z.string().max(2048)).default({}),
  body: z.string().min(1).max(4096),
});

export const criarAgendadaSchema = z.object({
  body: z.string().trim().min(1).max(4096),
  send_at: z.string().datetime({ offset: true }),
  template: modeloDaAgendadaSchema.nullable().optional(),
});
export type CriarAgendadaInput = z.infer<typeof criarAgendadaSchema>;

/**
 * Editar exige o `updated_at` que a tela viu: é a trava otimista contra a
 * corrida com o worker e com outra aba. Sem ele, um texto editado às 14:29:59
 * podia sobrescrever uma linha que o worker já reservou às 14:30.
 */
export const editarAgendadaSchema = z
  .object({
    expected_updated_at: z.string().datetime({ offset: true }),
    body: z.string().trim().min(1).max(4096).optional(),
    send_at: z.string().datetime({ offset: true }).optional(),
    template: modeloDaAgendadaSchema.nullable().optional(),
  })
  .refine((d) => d.body !== undefined || d.send_at !== undefined || d.template !== undefined, {
    message: "Nada para alterar.",
    path: ["body"],
  });
export type EditarAgendadaInput = z.infer<typeof editarAgendadaSchema>;
