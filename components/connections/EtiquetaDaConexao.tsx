"use client";
/**
 * A etiqueta da conexão: o rótulo pequeno que diz por qual número a conversa
 * entrou (lista do Chat) e a prévia dele no cartão da conexão. Um componente só
 * para as duas telas, para a prévia ser exatamente o que o Chat mostra.
 *
 * Sem cor (`null` ou chave desconhecida): a aparência de antes, contorno e
 * texto apagado. Com cor: fundo e texto da paleta de `lib/conexoes/cores.ts`,
 * pelos dois temas (as classes leem variáveis CSS que o `style` define).
 */
import { Badge } from "@/components/ui/badge";
import { ESTILO_DA_ETIQUETA_COLORIDA, lerCorDaConexao, variaveisDaCor } from "@/lib/conexoes/cores";
import { cn } from "@/lib/utils";

export function EtiquetaDaConexao({
  texto,
  cor,
  title,
  className,
}: {
  texto: string;
  cor: string | null | undefined;
  title?: string;
  className?: string;
}) {
  const chave = lerCorDaConexao(cor);
  return (
    <Badge
      variant="outline"
      data-cor-da-conexao={chave ?? undefined}
      className={cn(
        "h-4 max-w-[9rem] min-w-0 gap-1 truncate px-1.5 text-[10px] font-normal",
        chave ? ESTILO_DA_ETIQUETA_COLORIDA : "text-text-muted",
        className,
      )}
      style={variaveisDaCor(chave) ?? undefined}
      title={title}
    >
      <span className="truncate">{texto}</span>
    </Badge>
  );
}
