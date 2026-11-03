# Automações, lote 2: Pergunta, Mensagem com botões e Sem resposta

Geradas por `tests/e2e/automacoes-botoes-e-pergunta.spec.ts` (cenário "Qualificar contato" de uma
imobiliária), em ambiente fresco local, número de WhatsApp não oficial (WAHA) com receptor HTTP real.
O nome da automação leva um carimbo curto no fim porque o banco do e2e é compartilhado.

| Imagem                                     | O que mostra                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-editor-com-o-fluxo-montado.png`        | O fluxo inteiro no editor: Início (Manual), Fazer pergunta, Enviar mensagem com os caminhos "Moradia", "Investimento", "Sem resposta", "Erro" e "Resposta inválida", as duas Ações de CRM (tags) e os Fins. |
| `02-formulario-da-pergunta.png`            | Formulário do bloco Pergunta: "Qual é o seu nome?", salvo no campo "Nome informado", tipo de resposta Texto, tempo de espera e novas tentativas.                                                            |
| `03-formulario-da-mensagem-com-botoes.png` | Formulário do bloco Mensagem: "Qual o propósito do imóvel?" com os botões "Moradia" e "Investimento", aviso de que fora do WhatsApp oficial as opções chegam numeradas, espera de 1 minuto.                 |
| `04-conversa-no-inbox.png`                 | A conversa da Maria no Chat: a pergunta, a resposta "Maria Souza", a mensagem com "1) Moradia" e "2) Investimento" e a escolha "2".                                                                         |
| `05a-negocio-com-a-tag.png`                | O negócio da Maria com a tag "investimento" marcada.                                                                                                                                                        |
| `05b-negocio-com-o-campo.png`              | O mesmo negócio com o campo "Nome informado" preenchido com "Maria Souza".                                                                                                                                  |
| `06-lista-de-execucoes.png`                | A tela de Execuções da automação, com as duas execuções (Maria e João).                                                                                                                                     |
| `07-execucao-em-portugues.png`             | A história da execução da Maria em português: pergunta enviada, resposta registrada (sem o texto dela), mensagem enviada, escolheu "Investimento", tag adicionada, fim.                                     |
| `08-execucao-sem-resposta.png`             | A execução do João, que não escolheu nada: depois de 1 minuto o fluxo foi para "Sem resposta do contato".                                                                                                   |
