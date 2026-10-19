/**
 * Baixa o CSV de contatos no navegador: pede ao servidor (POST, porque a seleção pode
 * ter milhares de ids) e entrega o arquivo como download. O arquivo é montado NO SERVIDOR
 * (`app/api/v1/contacts/export`); aqui só se transporta.
 *
 * Erro da rota (papel insuficiente, teto, lista vazia) volta como `Error` com a mensagem
 * que ela escreveu — a tela a mostra como está.
 */
export type AlvoDaExportacao =
  | { ids: string[] }
  | { filtro: Record<string, string>; esperado?: number };

export async function baixarCsvDeContatos(alvo: AlvoDaExportacao): Promise<{ linhas: number; arquivo: string }> {
  const res = await fetch("/api/v1/contacts/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(alvo),
  });
  if (!res.ok) {
    let mensagem = "Não foi possível exportar os contatos.";
    try {
      const corpo = (await res.json()) as { error?: { message?: string } };
      if (corpo.error?.message) mensagem = corpo.error.message;
    } catch {
      // corpo que não é JSON: fica a mensagem padrão
    }
    throw new Error(mensagem);
  }
  const blob = await res.blob();
  const arquivo =
    /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "contatos.csv";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = arquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // O download já foi entregue ao navegador; liberar o blob depois de um tick evita cortar o arquivo.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { linhas: Number(res.headers.get("X-Contatos-Exportados") ?? "0"), arquivo };
}
