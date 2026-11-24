import Link from "next/link";

import { LogotipoDoProduto } from "@/components/branding/MarcaDoProduto";
import { AcaoDoNavegador } from "@/components/redesign/AcaoDoNavegador";
import { marcaEhADoProduto } from "@/lib/branding";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { Lock, MagnifyingGlass, Pause, Warning } from "@/lib/ui/icons";

/**
 * O CARTÃO DAS PÁGINAS DE SISTEMA NO V49 (onda 2 do redesign).
 *
 * Só é montado com a chave ligada: a página de sempre continua intacta no
 * ramo desligado. Logo da marca em cima, ícone redondo com o tom do erro,
 * rótulo "Erro NNN", título, as duas linhas do protótipo (o que aconteceu / o
 * que fazer), ação principal, secundária e o nome da marca no rodapé.
 *
 * Marca vem do resolvedor de saída (`marcaDaSaida`), nunca de texto fixo.
 * As peças são as de `lib/redesign/sistema.ts`, pintadas pelo bloco
 * "redesign: sistema" de `app/globals.css`.
 */
export type TomDoSistema = "aviso" | "info" | "erro" | "pausa";

export type AcaoDoSistema =
  | { tipo: "link"; href: string; rotulo: string }
  | { tipo: "voltar" | "recarregar"; rotulo: string };

const ICONE = { aviso: Lock, info: MagnifyingGlass, erro: Warning, pausa: Pause } as const;

function Acao({ acao, className }: { acao: AcaoDoSistema; className: string }) {
  if (acao.tipo === "link") {
    return (
      <Link href={acao.href} className={className}>
        {acao.rotulo}
      </Link>
    );
  }
  return <AcaoDoNavegador acao={acao.tipo} rotulo={acao.rotulo} className={className} />;
}

export function PaginaDoSistema({
  codigo,
  tom,
  icone = tom,
  titulo,
  linhas,
  principal,
  secundaria,
  marca,
  idioma,
  children,
}: {
  codigo?: string;
  tom: TomDoSistema;
  /** O desenho do ícone, quando difere do tom (503 é aviso com pausa). */
  icone?: TomDoSistema;
  titulo: string;
  linhas: readonly [string, string];
  principal: AcaoDoSistema;
  secundaria?: AcaoDoSistema;
  marca: Pick<MarcaDeSaida, "nome" | "logoUrl">;
  idioma: Idioma;
  children?: React.ReactNode;
}) {
  const Icone = ICONE[icone];
  return (
    <main className="flex min-h-screen flex-col items-center justify-center" data-rd-sistema="pagina">
      <div className="flex justify-center" data-rd-sistema="logo">
        {marca.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- URL de quem hospeda; ver app/(public)/layout.tsx
          <img src={marca.logoUrl} alt={marca.nome} className="h-auto max-h-10 w-auto max-w-[12rem] object-contain" />
        ) : marcaEhADoProduto({ name: marca.nome, logoUrl: null }) ? (
          <LogotipoDoProduto nome={marca.nome} className="h-7 w-auto" />
        ) : (
          <span>{marca.nome}</span>
        )}
      </div>
      <section className="w-full text-center" data-rd-sistema="cartao">
        <span className="mx-auto flex items-center justify-center" data-rd-sistema="icone" data-tom={tom} aria-hidden="true">
          <Icone weight="bold" />
        </span>
        {codigo ? (
          <p data-rd-sistema="rotulo">
            {traduzir("Erro", idioma)} {codigo}
          </p>
        ) : null}
        <h1 data-rd-sistema="titulo">{titulo}</h1>
        <p data-rd-sistema="texto">{linhas[0]}</p>
        <p data-rd-sistema="texto">{linhas[1]}</p>
        {children}
        <div className="flex flex-col items-stretch" data-rd-sistema="acoes">
          <Acao acao={principal} className="inline-flex items-center justify-center" />
          {secundaria ? <Acao acao={secundaria} className="inline-flex items-center justify-center" /> : null}
        </div>
      </section>
      <p data-rd-sistema="rodape">{marca.nome}</p>
    </main>
  );
}
