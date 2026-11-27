import { LogotipoDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O logo das telas do redesign que ficam fora do `/app` (páginas de sistema,
 * convite). Mesma ordem de `app/(public)/layout.tsx`: o logo gravado pela
 * instalação; senão o logotipo do produto, quando a marca é a do produto;
 * senão o nome em texto. Nunca texto fixo.
 */
export function LogoDaMarca({ marca }: { marca: Pick<MarcaDeSaida, "nome" | "logoUrl"> }) {
  if (marca.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- URL de quem hospeda; ver app/(public)/layout.tsx
      <img src={marca.logoUrl} alt={marca.nome} className="h-auto max-h-10 w-auto max-w-[12rem] object-contain" />
    );
  }
  if (marcaEhADoProduto({ name: marca.nome, logoUrl: null })) {
    return <LogotipoDoProduto nome={marca.nome} className="h-7 w-auto" />;
  }
  return <span>{marca.nome}</span>;
}
