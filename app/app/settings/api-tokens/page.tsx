import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ApiTokensClient } from "./_components/ApiTokensClient";
import { traduzir } from "@/lib/i18n/dicionario";
import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { CAMINHO_CONECTAR_ASSISTENTE_DE_IA } from "@/lib/ajuda/artigos";
import { urlDoServidorMcp } from "@/lib/mcp/url-do-servidor";
import { recursosDaChave } from "@/lib/api/plano-da-api";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;
  // D-227: o que a chave serve neste plano decide o botão de criar. Cliente de
  // serviço porque `fn_billing_limites_efetivos` só responde a `service_role`;
  // a organização vem da sessão, já checada acima.
  const plano = await planoDaOrganizacao(createAdminClient(), activeOrg.orgId, logger);
  const recursos = recursosDaChave(plano.limites, plano.leituraFalhou);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API Tokens</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Tokens server-to-server. Plaintext exibido", idioma)}{" "}
          <strong>{traduzir("uma única vez", idioma)}</strong>{" "}
          {traduzir("na criação.", idioma)}
        </p>
        <p className="text-sm text-muted-foreground">
          {traduzir("Endereço do MCP:", idioma)}{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs" data-testid="api-tokens-url-do-mcp">
            {urlDoServidorMcp()}
          </code>
        </p>
        <LinkDeAjudaDaTela />
        <LinkDeAjudaDaTela
          caminho={CAMINHO_CONECTAR_ASSISTENTE_DE_IA}
          rotulo={traduzir("Como conectar um assistente de IA", idioma)}
          semPrefixo
        />
      </header>
      <ApiTokensClient recursos={recursos} />
    </div>
  );
}
