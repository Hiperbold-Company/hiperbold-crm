import { Suspense } from "react";
import type { Metadata } from "next";
import { ContactsListClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contatos" };

export default function ContactsPage() {
  // `useSearchParams` (os filtros moram na URL) pede a fronteira de Suspense.
  return (
    <Suspense>
      <ContactsListClient />
    </Suspense>
  );
}
