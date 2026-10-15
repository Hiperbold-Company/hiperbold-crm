/**
 * "Confirme seu e-mail": sai no cadastro e no "Reenviar" da faixa do CRM (`lib/auth/enviar-verificacao-email.ts`).
 * Leva o link de uso único de `/auth/verificar-email?token=`. O layout é o de `_layout-transacional.ts`.
 *
 * Não é o e-mail de confirmação do Supabase (`acesso-gotrue.ts`): aquele fica desligado em produção
 * (`mailer_autoconfirm`), e este é o do CRM.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "CONTA-VERIFICAR-EMAIL";

export interface ConfirmarEmailOptions extends OpcoesBaseDoEmail {
  /** Validade do link, em dias. */
  dias: number;
}

export function buildConfirmarEmailEmail(opts: ConfirmarEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const crm = marca.nome;

  const assunto = preencher(traduzir("Confirme seu e-mail no {crm}", idioma), { crm });
  const texto = preencher(
    traduzir(
      "Para confirmar que este endereço é seu, use o botão abaixo. O link vale por {dias} dias e funciona uma vez só.",
      idioma,
    ),
    { dias: opts.dias },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Confirmação de e-mail", idioma), tom: "info" },
    titulo: traduzir("Confirme seu e-mail", idioma),
    paragrafos: [texto],
    botao: { texto: traduzir("Confirmar e-mail", idioma), url: opts.url },
    motivoDoRodape: preencher(
      traduzir(
        "Você recebe este e-mail porque criou uma conta no {crm}. Se não foi você, ignore esta mensagem.",
        idioma,
      ),
      { crm },
    ),
  });

  return { subject: paraAssunto(assunto), html, text };
}
