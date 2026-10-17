import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { retomarContaPelaRecuperacao } from "@/lib/auth/retomar-conta-pela-recuperacao";
import { carimbarEmailVerificado, emailVerificado } from "@/lib/auth/verificacao-email";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue: confirmação de signup E
 * redefinição de senha. Dois formatos de link chegam aqui, dependendo de como
 * o projeto Supabase está configurado:
 *
 * - `token_hash` + `type`: template de e-mail customizado (supabase/templates/,
 *   subidos por `hostgator-setup-kit/marca-emails.sh`) linkando direto pro app.
 *   NÃO exige SMTP customizado — a versão anterior deste comentário afirmava
 *   que sim ("sem isso o Supabase não deixa editar o corpo do e-mail") e isso
 *   foi MEDIDO como falso em 2026-08-14: `GET /v1/projects/{ref}/config/auth`
 *   do projeto de produção devolve `smtp_host: null` COM os templates
 *   customizados gravados, e um `PATCH` de `mailer_templates_*` num projeto
 *   sem SMTP responde 200 e persiste byte a byte (conferido relendo com GET).
 *   O que exige SMTP próprio é o VOLUME de envio, não o corpo do e-mail.
 * - `code` (PKCE): template PADRÃO do Supabase (o de quem nunca configurou os
 *   templates — caso mais comum em instalação fresca). O e-mail linka pro
 *   `/auth/v1/verify` do próprio GoTrue, que valida e SÓ ENTÃO redireciona pra
 *   cá com o code; não inclui `type`, por isso requestPasswordReset.ts e
 *   signUp.ts anexam `?type=` no redirectTo/emailRedirectTo — é o único jeito
 *   desse dado sobreviver ao hop pelo GoTrue nesse formato.
 *
 *   ⚠️ O formato `code` NÃO FECHA nesta instalação, e o motivo é estrutural.
 *   `@supabase/ssr` força `flowType: "pkce"` (createServerClient.js:33) e grava
 *   o verificador num cookie (`<storageKey>-code-verifier`, cookies.js:18) com
 *   as MESMAS `cookieOptions` da sessão (cookies.js:227,232) — isto é, com o
 *   `sameSite: "strict"` de `lib/supabase/server.ts:35`. Clique de link vindo
 *   de webmail é navegação CROSS-SITE: o navegador não manda cookie Strict, o
 *   verificador não chega, e `exchangeCodeForSession` falha. O formato
 *   `token_hash` não depende de cookie nenhum.
 *
 *   (O que NÃO está medido: um cliente de e-mail nativo abre o link sem
 *   iniciador, e nesse caso o navegador PODE mandar o cookie Strict. Por isso a
 *   mensagem da tela aponta a configuração como conserto, e não promete que
 *   "abrir noutro lugar" funciona.)
 *
 *   É por isso que a recusa dos dois ramos não pode ter a mesma mensagem:
 *   "link inválido ou expirado" manda o operador caçar TTL e relógio quando o
 *   problema é que os templates nunca foram configurados.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp/exchangeCodeForSession grava os
 * cookies de sessão via cookies() do next/headers; o Next anexa os Set-Cookie
 * ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  if (!(tokenHash && type) && !code) {
    return redirectTo("/login?error=link_invalido");
  }

  // Qual dos dois formatos chegou é um FATO observável, não inferência: o
  // `code` só existe no link que o template PADRÃO do Supabase monta. Guardar
  // isso antes da chamada é o que permite explicar a recusa depois.
  const viaTokenHash = Boolean(tokenHash && type);

  const supabase = await createClient();
  const { data, error } =
    tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code as string);

  // CLICAR DUAS VEZES NO MESMO LINK não é motivo para expulsar ninguém.
  // O token é de uso único: o segundo clique cai aqui com "Email link is
  // invalid or has expired" — e a pessoa está logada, porque o PRIMEIRO clique
  // firmou a sessão. Medido em 2026-09-10, no rig e numa instalação real:
  // `@supabase/ssr` NÃO apaga o cookie de sessão quando o `verifyOtp` falha
  // (o cookie continua na jar e o `getUser()` seguinte devolve o usuário).
  // Mandar essa pessoa para `/login?error=link_invalido` era, medido, o que
  // fazia dois convidados reais reentrarem pela senha e perderem o fio do
  // convite — terminando dentro do CRM sem organização e sem menu.
  let usuario = data?.user ?? null;
  let sessaoPreservada = false;
  if (error || !usuario) {
    const { data: jaAutenticado } = await supabase.auth.getUser();
    if (jaAutenticado.user) {
      usuario = jaAutenticado.user;
      sessaoPreservada = true;
    }
  }

  if (!usuario) {
    await audit({
      action: "auth.email_link_rejected",
      // `formato` é o campo que faltava: sem ele os dois modos de falha
      // chegavam ao audit log indistinguíveis, e a triagem de "o link não
      // funciona" começava do zero toda vez.
      metadata: { type, formato: viaTokenHash ? "token_hash" : "code", reason: error?.message ?? "no_user" },
      requestId,
    });
    // Dois códigos porque são duas causas e dois consertos. `link_invalido`
    // continua sendo "peça outro link". `template_padrao` diz o que a tela
    // antes escondia: o link veio do modelo padrão, pedir outro não adianta, e
    // o conserto é configurar os templates (hostgator-setup-kit/marca-emails.sh).
    return redirectTo(viaTokenHash ? "/login?error=link_invalido" : "/login?error=template_padrao");
  }

  if (sessaoPreservada) {
    // O link falhou — isso continua sendo fato e continua auditado. O que muda
    // é o desfecho: seguimos com a sessão que já existia, e o `formato` mais o
    // `sessao_preservada` deixam a triagem distinguir este caso do outro sem
    // adivinhar.
    await audit({
      action: "auth.email_link_rejected",
      actorUserId: usuario.id,
      metadata: {
        type,
        formato: viaTokenHash ? "token_hash" : "code",
        reason: error?.message ?? "no_user",
        sessao_preservada: true,
      },
      requestId,
    });
  }

  // O link foi CONSUMIDO agora (não é `sessaoPreservada`: uma sessão que já existia não prova nada) e chegou à
  // caixa de entrada do endereço da conta. É a prova de posse que o D-204 usa, e o que se faz com ela depende do
  // tipo do link.
  const consumidoAgora = !sessaoPreservada && Boolean(data?.user);
  const pedidoEmAberto = !emailVerificado(data?.user?.app_metadata);

  if (consumidoAgora && pedidoEmAberto && type === "signup") {
    // Confirmação de cadastro do próprio provedor (vale enquanto a confirmação automática está DESLIGADA): é o
    // fluxo legítimo de quem acabou de se cadastrar. Só carimba a verificação do CRM, SEM retomada: não há senha de
    // terceiro a desfazer, e sem este passo a pessoa ficaria presa à faixa "Confirme seu e-mail" por um endereço que
    // acabou de confirmar. Melhor esforço: a falha deixa a faixa, que tem o "Reenviar".
    try {
      const carimbo = await carimbarEmailVerificado({ admin: createAdminClient(), userId: usuario.id });
      if (!carimbo.ok) logger.warn("[auth/confirm] carimbo da verificação do e-mail falhou", { motivo: carimbo.motivo });
    } catch (e) {
      logger.warn("[auth/confirm] carimbo da verificação do e-mail lançou", {
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (consumidoAgora && pedidoEmAberto && (type === "recovery" || type === "magiclink" || type === "email")) {
    // PRÉ-SEQUESTRO (D-204). Recuperação de senha, link mágico e OTP de e-mail consumidos agora provam a posse do
    // endereço. Se a conta ainda tem a verificação do CRM em aberto, quem a criou pode ter a senha, sessões, um
    // TOTP e chaves de API: a senha vira aleatória, as outras sessões caem, os fatores saem, o que a conta criou é
    // revogado e o e-mail é carimbado (`lib/auth/reassumir-conta.ts`). Falha fechada: a sessão é encerrada e a
    // pessoa pede outro link.
    const retomada = await retomarContaPelaRecuperacao({
      admin: createAdminClient(),
      usuario,
      accessToken: data?.session?.access_token ?? null,
      // Pela sessão que o link acabou de abrir (ver `lib/auth/reassumir-conta.ts`).
      trocarSenhaDaSessao: (senha) => supabase.auth.updateUser({ password: senha }),
    });
    if (!retomada.ok) {
      await audit({
        action: type === "recovery" ? "auth.password_reset_failed" : "auth.email_link_rejected",
        actorUserId: usuario.id,
        metadata: { type, reason: "retomada_da_conta_falhou", etapa: retomada.etapa },
        requestId,
      });
      await supabase.auth.signOut();
      return redirectTo("/login?error=link_invalido");
    }
    if (retomada.retomada) {
      await audit({
        action: "auth.account_reclaimed_by_recovery",
        actorUserId: usuario.id,
        metadata: {
          type,
          fatores_removidos: retomada.fatoresRemovidos,
          tokens_revogados: retomada.revogados.tokens,
          convites_revogados: retomada.revogados.convites,
          entradas_desativadas: retomada.revogados.entradas,
        },
        requestId,
      });
      // Um fator verificado saiu e o provedor encerrou TODAS as sessões, a deste link inclusive. A conta já está
      // limpa: um novo link funciona sem o desafio de MFA.
      if (retomada.sessaoEncerrada) {
        await supabase.auth.signOut();
        return redirectTo("/login?error=conta_protegida");
      }
    }
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  // Foi convidado? Então NÃO ganha organização própria. Sem esta bifurcação,
  // quem clica no link do convite sem ter conta cria uma, cai aqui sem vínculo
  // nenhum, e `ensureTenantForUser` faz o que faria com qualquer visitante:
  // abre uma empresa e o torna admin dela. A pessoa fica com uma organização
  // fantasma, um wizard que não é dela e o gate de MFA de administrador.
  const decisao = decidirConviteDoSignup(usuario);

  if (decisao.tipo === "recusar") {
    // Falha FECHADA: havia convite e ele não vale (expirado ou de outra pessoa).
    // Provisionar aqui seria devolver o defeito com um conserto por cima.
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: decisao.motivo },
      requestId,
    });
    return redirectTo("/login?error=convite_invalido");
  }

  if (decisao.tipo === "convite") {
    // TERMINAR O SERVIÇO. Aqui já se sabe tudo o que o botão "Aceitar convite"
    // exigia — e com garantia mais forte: o token verificou (via
    // `decidirConviteDoSignup`) e o e-mail do convite bate com o que o PROVEDOR
    // DE AUTH acabou de confirmar, não com o que a sessão diz.
    //
    // Daqui saía um redirect para uma tela com um botão. Medido em duas
    // tentativas reais de um mesmo convidado: ninguém chegava a apertá-lo — na
    // primeira o segundo clique no e-mail derrubou o fluxo, na segunda a tela
    // veio pedindo login — e a pessoa terminava autenticada, sem organização e
    // sem menu, porque o VÍNCULO é o que dá as duas coisas.
    const aceite = await aplicarConvite({
      userId: usuario.id,
      payload: decisao.payload,
      requestId,
    });
    if (aceite.ok) return redirectTo("/app");

    // Convite revogado, ou banco fora: a tela de aceite continua existindo e
    // sabe explicar cada caso. Degradar para ela preserva exatamente o
    // comportamento anterior, em vez de deixar a pessoa sem saída.
    return redirectTo(`/team/accept-invite/${decisao.token}`);
  }

  // A TRAVA QUE MAIS IMPORTA. Aqui é onde a organização nasce, e este ponto
  // pega inclusive a conta que nasceu FORA da tela de cadastro — por uma chamada
  // direta à server action, ou por uma conta criada pela admin API do GoTrue.
  // Sem ele, fechar o cadastro seria decoração: bastaria pular a tela.
  //
  // Depois de `decidirConviteDoSignup`, de propósito: quem tem convite válido já
  // saiu acima, então esta guarda só alcança quem chegou sem convite nenhum.
  const modo = await modoDeCadastro();
  if (modo === "so_convite") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "somente_convite" },
      requestId,
    });
    return redirectTo("/login?error=cadastro_por_convite");
  }

  // COM APROVAÇÃO (migration 0383): a empresa NÃO nasce aqui. O pedido é
  // enviado em `/get-started`, que é onde já chega quem ficou sem empresa por
  // qualquer outro caminho — uma porta só, e a trava mora na action dela
  // (`recoverOrganization`), não nesta rota.
  if (modo === "com_aprovacao") return redirectTo("/get-started");

  try {
    await ensureTenantForUser(usuario);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: usuario.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    // A sessão JÁ está firmada (o `verifyOtp`/`exchangeCodeForSession` acima
    // passou). Mandar para `/login` deixava a pessoa logada e sem organização,
    // sem nenhum caminho de volta — ver `app/actions/auth/recoverOrganization.ts`.
    return redirectTo("/get-started");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: usuario.id,
    metadata: {},
    requestId,
  });

  // O roteador do wizard escolhe o passo: pagamento (compra ligada) ou boas-vindas (wizard completo).
  return redirectTo("/onboarding");
}
