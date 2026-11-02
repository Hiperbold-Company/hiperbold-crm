/**
 * O contexto de `renderTemplate` numa automação: `{{contact.*}}`, `{{lead.*}}`,
 * `{{campo.<chave>}}`, `{{gatilho.*}}` e `{{sistema.agora|data|hora}}`.
 *
 * `contact` e `lead` são as linhas AO VIVO (fatos do passo); `gatilho` é a
 * projeção do evento guardada em `vars.gatilho` quando a execução nasceu.
 * O CPF nunca sai (regra do próprio `renderTemplate`).
 */
import { renderTemplate } from "@/lib/automation/template";

import type { FatosDaAutomacao } from "./fatos";

const TZ_PADRAO = "America/Sao_Paulo";

function parte(agora: Date, opcoes: Intl.DateTimeFormatOptions, tz: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, ...opcoes }).format(agora);
}

export function contextoDoTemplate(
  fatos: FatosDaAutomacao | null,
  agora: Date,
  tz: string = TZ_PADRAO,
): Record<string, unknown> {
  const vars = fatos?.vars ?? {};
  return {
    contact: fatos?.contato ?? null,
    lead: fatos?.negocio ?? null,
    gatilho: (vars.gatilho as Record<string, unknown> | undefined) ?? {},
    sistema: {
      agora: agora.toISOString(),
      data: parte(agora, { day: "2-digit", month: "2-digit", year: "numeric" }, tz),
      hora: parte(agora, { hour: "2-digit", minute: "2-digit", hour12: false }, tz),
    },
  };
}

export function renderizar(texto: string, fatos: FatosDaAutomacao | null, agora: Date): string {
  return renderTemplate(texto, contextoDoTemplate(fatos, agora));
}
