/**
 * O avatar REDONDO da empresa: a logo que ela enviou, com recorte central, ou as
 * iniciais do nome sobre uma cor.
 *
 * A cor sai do NOME, por uma conta fixa: a mesma empresa tem sempre a mesma cor,
 * em toda tela e em todo navegador, e duas empresas vizinhas no seletor tendem a
 * cores diferentes. Luminosidade baixa e fixa para o texto branco ler bem em
 * qualquer matiz.
 *
 * `<img>` e não `next/image` pelo mesmo motivo da barra lateral: a URL é do
 * storage de quem hospeda, e `next/image` exige allowlist de domínios fechada no
 * build da imagem genérica.
 */

import { iniciaisDoNome } from "@/lib/ui/iniciais";
import { cn } from "@/lib/utils";

/** Matiz de 0 a 359 a partir do nome. Pura e estável. */
export function matizDoNome(nome: string): number {
  let soma = 0;
  for (const ch of nome) soma = (soma * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return soma;
}

interface Props {
  readonly nome: string;
  readonly logoUrl?: string | null;
  /** Lado em pixels. Padrão 32. */
  readonly tamanho?: number;
  readonly className?: string;
}

export function AvatarDaEmpresa({ nome, logoUrl, tamanho = 32, className }: Props) {
  const lado = { width: tamanho, height: tamanho };
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        data-avatar-da-empresa="logo"
        style={lado}
        className={cn("shrink-0 rounded-full border border-border bg-white object-cover", className)}
      />
    );
  }
  const iniciais = iniciaisDoNome(nome, { palavraUnica: 2 }) ?? "?";
  return (
    <span
      aria-hidden
      data-avatar-da-empresa="iniciais"
      style={{
        ...lado,
        backgroundColor: `hsl(${matizDoNome(nome)} 50% 32%)`,
        fontSize: Math.max(10, Math.round(tamanho * 0.38)),
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white",
        className,
      )}
    >
      {iniciais}
    </span>
  );
}
