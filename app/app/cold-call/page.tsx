import type { Metadata } from "next";

import { ColdCall } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ligações em lista" };

export default function ColdCallPage() {
  return <ColdCall />;
}
