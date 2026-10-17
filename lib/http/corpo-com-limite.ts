import "server-only";

/**
 * Leitura de corpo HTTP com teto de tamanho, em FLUXO (não confia no
 * `Content-Length` declarado: o cabeçalho pode mentir, seja por engano do
 * remetente ou de propósito). Usado pelo webhook do Asaas (fase F5, Tarefa
 * 12, decisão 19), que tem teto de 64 KB independente do que o cabeçalho diz.
 *
 * Quem chama ainda deve conferir `Content-Length` ANTES de chamar esta
 * função, para recusar sem gastar leitura nenhuma quando o cabeçalho já
 * declara um valor acima do teto - esta função cobre o caso em que o
 * cabeçalho declara pouco (ou nada) e o corpo real excede o teto mesmo assim.
 *
 * Concatena os pedaços com `Buffer.concat` (nunca `texto += chunk`): um chunk
 * pode cortar no meio de um caractere UTF-8 multibyte, e concatenar strings
 * nesse ponto corrompe o acento (ver nota de memória "Node: nunca
 * `d += chunk` em resposta HTTP").
 */
export interface ResultadoCorpoComLimite {
  /** `false` quando o corpo (em bytes) passou do teto; `texto` fica vazio. */
  ok: boolean;
  texto: string;
}

export async function lerCorpoComLimite(
  corpo: ReadableStream<Uint8Array> | null,
  limiteBytes: number,
): Promise<ResultadoCorpoComLimite> {
  if (!corpo) {
    return { ok: true, texto: "" };
  }

  const reader = corpo.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limiteBytes) {
      // Corta assim que o fluxo real passa do teto, sem esperar o resto
      // chegar: o remetente pode estar mandando megabytes atrás de um
      // Content-Length pequeno.
      try {
        await reader.cancel();
      } catch {
        // Cancelar um fluxo já finalizado/abortado nunca é motivo de falha
        // aqui: o que importa é que já decidimos recusar por tamanho.
      }
      return { ok: false, texto: "" };
    }
    pedacos.push(value);
  }

  const bytes = Buffer.concat(pedacos.map((p) => Buffer.from(p)));
  // TextDecoder (e não `Buffer#toString`) para tirar o BOM UTF-8 inicial, como o `req.text()` fazia: com o BOM
  // `JSON.parse` falha e o HMAC seria conferido sobre um texto que o remetente não assinou.
  return { ok: true, texto: new TextDecoder("utf-8").decode(bytes) };
}

/**
 * Corpo de uma requisição com teto, nos dois passos que o webhook público precisa:
 * recusa pelo `Content-Length` declarado (sem ler nada) e, depois, pelo fluxo real
 * (o cabeçalho pode mentir ou faltar, como no `Transfer-Encoding: chunked`).
 *
 * `req.text()` lê tudo o que o remetente mandar. Em rota por token (o token é um
 * segredo fraco: vai na URL cadastrada em painel de terceiro) isso deixa qualquer
 * um que o conheça encher a memória do processo e, nas rotas que arquivam, o banco.
 */
export async function lerCorpoDaRequisicao(
  req: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  limiteBytes: number,
): Promise<ResultadoCorpoComLimite> {
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > limiteBytes) {
    return { ok: false, texto: "" };
  }
  return lerCorpoComLimite(req.body, limiteBytes);
}
