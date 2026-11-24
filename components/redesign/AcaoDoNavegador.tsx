"use client";

/**
 * As duas ações das páginas de sistema do v49 que só o navegador sabe fazer:
 * voltar à página anterior e recarregar a atual. Nenhuma fala com o servidor.
 */
export function AcaoDoNavegador({
  acao,
  rotulo,
  className,
}: {
  acao: "voltar" | "recarregar";
  rotulo: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => (acao === "voltar" ? window.history.back() : window.location.reload())}
    >
      {rotulo}
    </button>
  );
}
