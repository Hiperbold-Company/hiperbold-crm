import { funcaoOculta, type FuncaoId } from "../../../lib/hiperbold/funcoes-ocultas";

/**
 * Pula o arquivo de spec inteiro enquanto a função estiver na lista de ocultas da instalação
 * (lib/hiperbold/funcoes-ocultas.ts). Decisão do Filipe, 16/10/2026: a função está escondida do
 * cliente e a tela redireciona para /app/inicio, então a jornada não tem por onde ser exercida.
 * Religar a função (hiperbold/FUNCOES.md) religa a spec sozinha: nenhuma edição aqui.
 *
 * Chamar no topo do arquivo, passando o `test` do próprio arquivo.
 */
export function pularSeOculta(
  test: { skip: (condicao: boolean, descricao: string) => void },
  id: FuncaoId,
): void {
  test.skip(
    funcaoOculta(id),
    `Função "${id}" oculta em 16/10/2026 (hiperbold/FUNCOES.md): reativar junto com a função`,
  );
}
