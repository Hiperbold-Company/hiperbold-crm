/**
 * Reconectar uma conexão que já existe (o aparelho saiu e precisa ler um QR
 * novo) — a face neutra que rota e tela usam.
 *
 * Mesma razão de `./pareamento-qr`: a rota não pode nomear o provider (o
 * `lint:channels` reprova até no caminho de um import). O que fala com o
 * servidor e o que grava a linha mora em `./uazapi/reconexao`; a rota fala em
 * conceitos: "a reconexão", "o QR", "o código".
 */
export {
  iniciarReconexao,
  verificarReconexao,
  type EstadoDaReconexao,
  type FalhaDaReconexao,
  type ReconexaoAguardando,
  type ReconexaoConcluida,
} from "./uazapi/reconexao";

import type { EstadoDaReconexao } from "./uazapi/reconexao";

/** O corpo que a tela recebe, em snake_case, igual nas duas rotas da reconexão. */
export function respostaDaReconexao(r: EstadoDaReconexao) {
  if (r.estado === "conectado") {
    return {
      id: r.id,
      estado: r.estado,
      conexao: {
        id: r.conexao.id,
        display_name: r.conexao.displayName,
        phone_number: r.conexao.phoneNumber,
        status: r.conexao.status,
      },
      webhook: r.webhook,
      numero_mudou: r.numeroMudou,
    };
  }
  return { id: r.id, estado: r.estado, qr: r.qr, codigo: r.codigo };
}
