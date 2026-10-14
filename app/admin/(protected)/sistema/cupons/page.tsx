import Link from "next/link";
import { notFound } from "next/navigation";

import { listarCupons, type CupomListado } from "@/app/actions/admin/cupons";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { planosParaVenda } from "@/lib/billing/asaas/leitura";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { FormularioDeNovoCupom, ListaDeCupons } from "./_client";

export const metadata = { title: "Cupons de desconto" };
export const dynamic = "force-dynamic";

/**
 * A tela de cupons de desconto da instalação (migration 0955, fork Hiperbold): lista, ativar e desativar,
 * e o formulário de cupom novo. Irmã de `../cobranca`, no mesmo molde: Server Component que lê, e um
 * componente cliente (`./_client`) só para as ações.
 *
 * ─── Onde mora a barreira de verdade ────────────────────────────────────────
 *
 * `podeEscrever` só decide o que a tela MOSTRA. Cada ação de `app/actions/admin/cupons.ts` confere de novo
 * `requirePlatformAdmin()`, o escopo `full` e o MFA em dia, inclusive a leitura (`listarCupons`): cupom é
 * preço, então o suporte só leitura nem vê a lista. Esconder o botão é conveniência, não segurança.
 */
export default async function CuponsPage() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { platformAdmin } = await requirePlatformAdmin();
  const podeEscrever = platformAdmin.scope === "full";
  const t = (texto: string) => traduzir(texto, usuario.idioma);

  let cupons: CupomListado[] = [];
  let erroDaLista: string | null = null;
  let planos: { code: string; name: string }[] = [];

  if (podeEscrever) {
    const [lista, planosLidos] = await Promise.all([listarCupons(), planosParaVenda(createAdminClient())]);
    if (lista.ok) cupons = lista.cupons;
    else erroDaLista = lista.error;
    planos = planosLidos.planos.map((p) => ({ code: p.code, name: p.name }));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/sistema" className="text-sm text-primary underline-offset-4 hover:underline">
          {t("Voltar para Comportamento da instalação")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Cupons de desconto")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "O cliente digita o cupom na tela de assinar. O desconto vale só na primeira cobrança, o total mínimo é R$ 5,00, cada conta e cada CPF/CNPJ usam o cupom uma vez e pacote de tokens não tem cupom.",
          )}
        </p>
      </div>

      {!podeEscrever ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t("Seu acesso de suporte não permite mexer nos cupons.")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("Cupons")}</CardTitle>
            </CardHeader>
            <CardContent>
              {erroDaLista ? (
                <p className="text-sm text-destructive" role="alert">
                  {erroDaLista}
                </p>
              ) : (
                <ListaDeCupons cupons={cupons} planos={planos} />
              )}
            </CardContent>
          </Card>

          <FormularioDeNovoCupom planos={planos} />
        </>
      )}
    </div>
  );
}
