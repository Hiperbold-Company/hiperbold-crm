/**
 * O contexto de `renderTemplate` numa automação: `{{contact.*}}`, `{{lead.*}}`,
 * `{{campo.<chave>}}`, `{{gatilho.*}}`, `{{resposta.<chave do nó>}}` e
 * `{{sistema.agora|data|hora}}`.
 *
 * `contact` e `lead` são as linhas AO VIVO (fatos do passo); `gatilho` é a
 * projeção do evento guardada em `vars.gatilho` quando a execução nasceu.
 * O CPF nunca sai (regra do próprio `renderTemplate`).
 */
import { renderTemplate } from "@/lib/automation/template";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

import type { FatosDaAutomacao } from "./fatos";

const TZ_PADRAO = "America/Sao_Paulo";

function parte(agora: Date, opcoes: Intl.DateTimeFormatOptions, tz: string, idioma: Idioma): string {
  return new Intl.DateTimeFormat(tagDeIdioma(idioma), { timeZone: tz, ...opcoes }).format(agora);
}

export function contextoDoTemplate(
  fatos: FatosDaAutomacao | null,
  agora: Date,
  tz: string = TZ_PADRAO,
  /** Idioma da data em `{{sistema.data}}`: o da organização; sem ele, o padrão do produto. */
  idioma: Idioma = IDIOMA_PADRAO,
): Record<string, unknown> {
  const vars = fatos?.vars ?? {};
  return {
    contact: fatos?.contato ?? null,
    lead: fatos?.negocio ?? null,
    gatilho: (vars.gatilho as Record<string, unknown> | undefined) ?? {},
    // Respostas dos blocos de conversa: `{{resposta.<chave do nó>}}` (`lib/automacoes/conversa.ts`).
    resposta: (vars.resposta as Record<string, unknown> | undefined) ?? {},
    sistema: {
      agora: agora.toISOString(),
      data: parte(agora, { day: "2-digit", month: "2-digit", year: "numeric" }, tz, idioma),
      hora: parte(agora, { hour: "2-digit", minute: "2-digit", hour12: false }, tz, idioma),
    },
  };
}

export function renderizar(texto: string, fatos: FatosDaAutomacao | null, agora: Date): string {
  return renderTemplate(texto, contextoDoTemplate(fatos, agora));
}
