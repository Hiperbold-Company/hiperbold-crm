import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * A antiga tela "Billing" era um placeholder do produto de origem (e-mail de suporte). Saiu do
 * catálogo, do hub e do ⌘K em 15/10/2026; o endereço fica só para link salvo não dar 404.
 * Quem decide o acesso é `/app/settings/plano` (gerente para cima; os demais vão para /403).
 */
export default function BillingPage() {
  redirect("/app/settings/plano");
}
