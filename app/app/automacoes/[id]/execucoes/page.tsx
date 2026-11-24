import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDasAutomacoes } from "@/lib/redesign/automacoes";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { dataHoraDaExecucao } from "@/lib/automacoes/data-da-lista";

export const dynamic = "force-dynamic";

/**
 * As execuções de UMA automação: quem passou por ela, quando e como terminou.
 * Cada linha abre o dossiê da execução (`/app/ai/followups/enrollments/[id]`),
 * que conta passo a passo, em português, o que cada bloco fez.
 */
export default async function ExecucoesDaAutomacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const rd = marcaDasAutomacoes(await redesignNaRequisicao());
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data: automacao } = await supabase
    .from("followup_flow_pointers")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .eq("surface", "automacao")
    .maybeSingle();
  if (!automacao) notFound();

  const { data: execucoes } = await supabase
    .from("followup_enrollments")
    .select("id, contact_id, status, started_at, completed_at, steps_taken, cancel_reason, last_error")
    .eq("organization_id", activeOrg.orgId)
    .eq("pointer_id", id)
    .eq("lane", "automacao")
    .order("started_at", { ascending: false })
    .limit(100);
  const lista = execucoes ?? [];
  const idsDeContato = [...new Set(lista.map((e) => e.contact_id))];
  const { data: contatos } = idsDeContato.length
    ? await supabase
        .from("contacts")
        .select("id, name, display_name, phone_number")
        .eq("organization_id", activeOrg.orgId)
        .in("id", idsDeContato)
    : { data: [] as Array<{ id: string; name: string | null; display_name: string | null; phone_number: string | null }> };
  // Rótulo canônico (name, depois display_name do WhatsApp, depois o telefone).
  const nomeDoContato = new Map((contatos ?? []).map((c) => [c.id, rotuloDoContato(c, t)]));
  const quando = (iso: string | null) => dataHoraDaExecucao(iso, user.idioma, activeOrg.timezone);

  return (
    <div className="flex h-full flex-col gap-6 p-6" data-rd-automacoes={rd("pagina")}>
      <header className="space-y-1" data-rd-automacoes={rd("cabecalho")}>
        <Link href={`/app/automacoes/${id}`} className="text-xs text-accent-600 hover:underline" data-rd-automacoes={rd("link-secundario")}>
          ← {automacao.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight" data-rd-automacoes={rd("titulo")}>{t("Execuções")}</h1>
        <p className="text-sm text-text-muted" data-rd-automacoes={rd("descricao")}>{t("As últimas 100 vezes que esta automação rodou.")}</p>
      </header>
      {lista.length === 0 ? (
        <Card className="p-8 text-center text-sm text-text-muted" data-rd-automacoes={rd("vazio")}>
          {t("Ainda não rodou para nenhum contato.")}
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="lista-de-execucoes" data-rd-automacoes={rd("lista")}>
          {lista.map((e) => (
            <li key={e.id}>
              <Link href={`/app/ai/followups/enrollments/${e.id}`}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-3 transition-colors hover:border-accent-400" data-rd-automacoes={rd("item")}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{nomeDoContato.get(e.contact_id) ?? "—"}</p>
                    <p className="text-xs text-text-muted">
                      {t("Começou")} {quando(e.started_at)} · {e.steps_taken} {t("passos")}
                    </p>
                  </div>
                  <Badge variant={tomDoStatus(e.status)}>{rotuloDoStatus(e.status, t)}</Badge>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
