# Automações, lote 3: gatilhos e uma automação iniciando outra

Prova pela tela de `tests/e2e/automacoes-gatilhos.spec.ts`, no banco fresco do e2e
(baseline + seed), com o número de WhatsApp (WAHA) conectado como "WhatsApp da loja"
e a mensagem da contato entrando pelo webhook assinado do WAHA.

Cenário:

- **Rastrear origem**: começa quando outra automação a inicia (de qualquer uma) e
  grava no negócio o campo "Origem do contato" = `{{param.origem}}`.
- **Atender anúncio**: começa com mensagem recebida que contém "saber mais", só pelo
  "WhatsApp da loja"; inicia "Rastrear origem" passando `origem = anuncio`; aguarda
  1 dia; fim.
- **Acompanhar visita**: começa quando o negócio ganha a tag "visita"; põe a tag
  "acompanhar".

| Arquivo | O que mostra |
|---|---|
| `01-gatilho-mensagem-recebida.png` | Formulário do gatilho Mensagem recebida: "Contém a palavra ou frase", palavra-chave "saber mais", número escolhido, "Não disparar se um atendente estiver cuidando da conversa" |
| `02-acao-iniciar-outra-automacao.png` | Formulário da ação Iniciar outra automação: automação de destino e o dado `origem = anuncio` |
| `03-gatilho-iniciada-por-outra-automacao.png` | Formulário do gatilho Iniciada por outra automação, aceitando de qualquer uma, com a dica `{{param.chave}}` |
| `04-editor-atender-anuncio.png` | Editor de "Atender anúncio" publicado; o card de Ações de CRM diz o nome da automação iniciada |
| `05-lista-de-execucoes.png` | Execuções de "Rastrear origem": uma, da Ana Ribeiro |
| `06-execucao-rastrear-origem.png` | Execução de "Rastrear origem": "Iniciada pela automação “Atender anúncio”", "dados recebidos: {{param.origem}}" (só a chave; o valor não entra nos eventos) |
| `07-execucao-atender-anuncio-gatilho-ignorado.png` | Execução de "Atender anúncio": iniciou "Rastrear origem"; a segunda mensagem com "saber mais" virou "Gatilho ignorado: o contato já estava nesta automação" |
| `08-negocio-com-o-campo.png` | Ficha do negócio da Ana com "Origem do contato" = anuncio |
| `09-gatilho-tag-adicionada.png` | Formulário do gatilho Tag adicionada (negócio, tag "visita") |
| `10-execucao-tag-adicionada.png` | Execução de "Acompanhar visita" depois de a tag ser posta pela ficha do negócio |

O que a spec também mede (sem foto): "bom dia" não inicia nada (nenhuma execução nova
e nenhum "gatilho ignorado" a mais), e cada automação tem uma execução só para a Ana.

Os nomes das automações levam um sufixo curto (ex.: `mw16rnuj`) porque o banco do e2e
é compartilhado entre execuções da suíte.

Observação da foto 07: a segunda mensagem da Ana também acordou o bloco Aguardar
("O cliente respondeu — o fluxo acordou na hora") e a execução terminou antes de 1 dia.
É o comportamento atual da reatividade dos follow-ups aplicado às automações, registrado
como achado.
