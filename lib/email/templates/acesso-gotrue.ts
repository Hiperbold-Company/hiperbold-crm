import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";

/**
 * Os dois e-mails de ACESSO — confirmar conta e redefinir senha — no formato
 * que o GoTrue renderiza.
 *
 * ─── POR QUE ISTO É DIFERENTE DE `invite.ts` ────────────────────────────────
 *
 * O convite de time é montado e ENVIADO por nós. Estes dois não: quem os
 * renderiza e envia é o GoTrue, um processo de terceiro. Nós só entregamos o
 * MOLDE, e ele preenche `{{ .RedirectTo }}` e `{{ .TokenHash }}` na hora do
 * envio. Por isso a saída aqui é uma string de template Go, não um e-mail
 * pronto — e por isso as chaves duplas NÃO passam por escape: elas são sintaxe
 * do renderizador, não dado.
 *
 * ─── POR QUE `token_hash` E NÃO `{{ .ConfirmationURL }}` ────────────────────
 *
 * O modelo PADRÃO do GoTrue linka para `/auth/v1/verify`, que devolve um `code`
 * PKCE. O verificador desse code vive num cookie `SameSite=Strict`
 * (`lib/supabase/server.ts`), e clique vindo de webmail é navegação
 * cross-site: o cookie não viaja, `exchangeCodeForSession` falha, e a conta é
 * confirmada sem que a sessão feche. `token_hash` não depende de cookie nenhum.
 *
 * Medido numa instalação self-hosted em 2026-09-10: com o modelo padrão, o
 * `api_audit_log` registrava `auth.email_link_rejected` com
 * `"PKCE code verifier not found in storage"`; com estes moldes, o mesmo fluxo
 * fecha a sessão.
 *
 * ─── `&`, NUNCA `?` ────────────────────────────────────────────────────────
 *
 * `.RedirectTo` já chega com `?type=` embutido — `signUp.ts` e
 * `requestPasswordReset.ts` o anexam de propósito, porque é o único jeito de o
 * `type` sobreviver ao hop pelo GoTrue no outro formato. Um `?` aqui duplicaria
 * o separador e o parser de URL do browser pararia de reconhecer `token_hash`.
 */

export type ModeloDeAcesso = "confirmation" | "recovery";

export const MODELOS_DE_ACESSO: readonly ModeloDeAcesso[] = ["confirmation", "recovery"];

/** O texto de cada modelo. Assunto entra no `GOTRUE_MAILER_SUBJECTS_*`. */
const COPIA: Record<ModeloDeAcesso, { assunto: (marca: string) => string; titulo: string; corpo: (marca: string) => string; botao: string; rodape: string }> = {
  confirmation: {
    assunto: (marca) => `Confirme seu e-mail · ${marca}`,
    titulo: "Confirme seu e-mail",
    corpo: (marca) =>
      `Sua conta no ${marca} está quase pronta. Clique no botão abaixo para confirmar seu e-mail e ativar sua conta.`,
    botao: "Confirmar e-mail",
    rodape: "Se você não criou esta conta, ignore este e-mail.",
  },
  recovery: {
    assunto: (marca) => `Redefinir sua senha · ${marca}`,
    titulo: "Redefinir sua senha",
    corpo: (marca) =>
      `Recebemos um pedido para redefinir a senha da sua conta no ${marca}. Clique no botão abaixo para escolher uma nova.`,
    botao: "Definir nova senha",
    rodape:
      "Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma.",
  },
};

export function assuntoDoModelo(modelo: ModeloDeAcesso, marca: MarcaDeSaida): string {
  return COPIA[modelo].assunto(marca.nome);
}

/**
 * O molde, com a marca da INSTALAÇÃO já aplicada.
 *
 * Mesmo visual dos e-mails transacionais (`_layout-transacional.ts`): logo
 * fora do cartão, cartão branco, botão e, abaixo dele, o link por extenso para
 * quem não consegue clicar. Não reaproveita `montarEmailTransacional` porque o
 * destino aqui é sintaxe do GoTrue (`{{ .RedirectTo }}`), que não passa no
 * `urlSegura` de lá e não pode ser escapado.
 *
 * Estilo inline apenas e zero asset externo além do logo, pelas mesmas razões
 * de `invite.ts` — inclusive a dimensão no atributo, que o Outlook desktop
 * exige porque descarta `height` de style em imagem. Logo SVG vira o nome em
 * texto: o Gmail não mostra SVG em `<img>`.
 */
export function montarTemplateDeAcesso(modelo: ModeloDeAcesso, marca: MarcaDeSaida): string {
  const t = COPIA[modelo];
  const N = NEUTROS_DE_SAIDA;
  const nome = escapeHtml(marca.nome);
  const fonte = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  const logoUrl = marca.logoUrl && /^https?:\/\//i.test(marca.logoUrl) && !/\.svg(\?|#|$)/i.test(marca.logoUrl) ? marca.logoUrl : null;
  const cabecalho = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${nome}" height="36" style="display:block;height:36px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none">`
    : `<span style="font-size:20px;line-height:1.2;font-weight:700;color:${marca.accent}">${nome}</span>`;

  // As chaves duplas ficam CRUAS de propósito: o GoTrue as substitui.
  const destino = "{{ .RedirectTo }}&token_hash={{ .TokenHash }}";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(t.titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${N.fundo};font-family:${fonte};color:${N.texto}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${N.fundo}" style="background:${N.fundo}">
  <tr><td align="center" style="padding:0 16px 32px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      <tr><td align="left" style="padding:28px 0 20px">${cabecalho}</td></tr>
      <tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${N.linha};border-radius:12px;padding:36px 32px">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${N.texto}">${escapeHtml(t.titulo)}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${N.texto}">${escapeHtml(t.corpo(marca.nome))}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr>
          <td align="center" bgcolor="${marca.accent}" style="background:${marca.accent};border-radius:8px">
            <a href="${destino}" target="_blank" style="display:inline-block;padding:14px 28px;background:${marca.accent};color:${marca.accentFg};border-radius:8px;font-family:${fonte};font-size:15px;line-height:1.2;font-weight:600;text-decoration:none">${escapeHtml(t.botao)}</a>
          </td>
        </tr></table>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:${N.suave}">${escapeHtml(COPIE_O_LINK)}<br><a href="${destino}" target="_blank" style="word-break:break-all;color:${marca.accent}">${destino}</a></p>
        <p style="margin:0;padding-top:20px;border-top:1px solid ${N.linha};font-size:13px;line-height:1.5;color:${N.suave}">${escapeHtml(t.rodape)}</p>
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:${N.suave};text-align:center">${nome}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** A linha abaixo do botão, para quem não consegue clicar (pedido do Filipe em 15/10/2026). */
const COPIE_O_LINK = "Se o botão não funcionar, copie o link abaixo e cole no seu navegador:";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
