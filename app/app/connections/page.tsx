import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { bloqueioDoBotaoDeConexoes } from "@/lib/billing/planos/limite-de-conexoes";
import { ConexoesShell } from "@/components/connections/ConexoesShell";
import { pareamentoQrDisponivel } from "@/lib/channels/pareamento-qr";
import { canalGraphParceiroLigado, GRAPH_PARTNER_LABEL } from "@/lib/channels/graph-parceiro/credentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { acessoAntecipado } from "@/lib/hiperbold/funcoes-ocultas";
import { marcaDasConexoes } from "@/lib/redesign/conexoes";
import { redesignNaRequisicao } from "@/lib/redesign/chave";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Conexões" };

export default async function ConnectionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // Decisão do dono do produto (03/11/2026): administrador ou gerente veem Conexões;
  // atendente e leitor não. O mesmo piso do item do menu e das rotas da API da tela.
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const idioma = user.idioma;
  const rd = marcaDasConexoes(await redesignNaRequisicao());

  const key = process.env.WAHA_API_KEY;
  const wahaConfigured = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );
  const wacallsConfigured = Boolean(process.env.WACALLS_API_BASE_URL);

  // D-188: os canais que criam `channel_sessions` (instância, QR Code, oficial, parceiro, redes sociais)
  // usam o MESMO item da matriz de plano, "Conexões", somado entre todos, e ele bloqueia em qualquer modo de
  // `billing_settings`. Um só cálculo serve a todos; cada componente decide sozinho se o botão que ele
  // mostra é uma conexão NOVA.
  const bloqueio = await bloqueioDoBotaoDeConexoes(createAdminClient(), activeOrg.orgId, idioma, logger);

  return (
    <div className="flex h-full flex-col gap-6 p-6" data-rd-conexoes={rd("pagina")}>
      <header data-rd-conexoes={rd("cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight" data-rd-conexoes={rd("titulo")}>{traduzir("Conexões", idioma)}</h1>
        <p className="text-sm text-muted-foreground" data-rd-conexoes={rd("subtitulo")}>
          {traduzir("Gerencie suas conexões de atendimento", idioma)}
        </p>
        <LinkDeAjudaDaTela />
      </header>
      <ConexoesShell
        wahaConfigured={wahaConfigured}
        wacallsConfigured={wacallsConfigured}
        bloqueio={bloqueio}
        graphParceiro={canalGraphParceiroLigado() ? { label: GRAPH_PARTNER_LABEL } : null}
        // O mesmo piso de `PUT /api/v1/ai/pacing` (`manager`): abaixo disso a ficha
        // abre só para ler, em vez de oferecer um Salvar que a rota recusaria.
        podeEditarProtecao={ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager}
        // Só aparece com o servidor e o token de administrador configurados na instalação.
        pareamentoQr={await pareamentoQrDisponivel()}
        // Instagram e Messenger seguem ocultos no Criar para o cliente até a Meta aprovar o app;
        // o administrador da plataforma os vê para testar com a conta real.
        redesSociaisLiberadas={user.is_platform_admin || acessoAntecipado("conexao-redes-sociais", activeOrg.orgId)}
      />
    </div>
  );
}
