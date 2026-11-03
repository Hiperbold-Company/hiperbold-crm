# Automações do CRM — lote 1 (prova pela tela)

Gerada por `tests/e2e/automacoes-crm-basico.spec.ts`, em build de produção
(`pnpm build` + `next start`), contra o Supabase local com o baseline e a
migration 0986, logado como admin da organização de teste (com segundo fator).
Rodada local de 02/11/2026: `1 passed` sozinha e `14 passed (5.7m)` junto com
`tests/e2e/navegacao.spec.ts` (inclui "em 900px o menu não rola", com a porta
nova no sidebar do CRM).

Cenário "Novo lead do Facebook": Lead criado por fonte de captação → condição
"Origem contém facebook" → Definir campo "Mídia" = "Anúncio pago" → Ações de
CRM (tag "Facebook" no negócio + criar negócio no funil "Pós-venda") → Fim.

| Imagem | O que mostra |
|---|---|
| `01-lista-vazia-ou-com-automacoes.png` | A porta: "Automações" no grupo CRM do menu leva à lista, com o botão "Nova automação". |
| `02-gatilho-lead-criado.png` | Automação nova abre com Início → Fim; o Início escolhe o gatilho "Lead criado", "Qualquer funil", "Qualquer fonte de captação", e a regra de reentrada. A paleta vem agrupada (Início, CRM, Lógica, Controle). |
| `03-condicao-origem-contem-facebook.png` | Condição de campo escolhida na lista ("Origem", campo personalizado do funil), "contém", "facebook", com a frase da regra embaixo. |
| `04-definir-campo-midia.png` | Operação de campo: "Mídia" = "Anúncio pago", com a ajuda das variáveis. |
| `05-acoes-de-crm.png` | Duas ações em ordem: adicionar a tag "Facebook" no negócio e criar negócio no funil "Pós-venda" (etapa preenchida sozinha), e "Se uma ação falhar". |
| `06-automacao-publicada.png` | Grafo organizado, publicado (status Ativo), sem erro em bloco; blocos de efeito com as saídas "Erro" e "Concluído". "Testar com um contato" fica habilitado. |
| `07-execucoes.png` | Execuções da automação: o lead da Ana, concluído. |
| `08-execucao-em-portugues.png` | A história da execução em português: "A automação começou — um lead foi criado", "Começou a executar as ações", "Ações executadas — Campos: midia", "Adicionar tags: feito; Criar negócio: negócio criado". Nenhum identificador cru (a spec mede). |
| `09-negocio-criado-no-pos-venda.png` | O negócio novo da Ana no funil "Pós-venda". |

O que a spec confere além das imagens (pela API e pelo banco local, só leitura):
o negócio da captação ganhou `midia = "Anúncio pago"` e a tag "Facebook"; o lead
com origem "Google" passou pela condição e não ganhou nada; e o follow-up manual
do mesmo contato da Ana foi matriculado e segue vivo (raias separadas).

Limites desta prova: o lead entra pela rota de captação (é o que um formulário
de anúncio faz), não pelo diálogo "Novo lead"; os crons (dreno do event_log e
worker de fluxos) são chamados pela spec, como o `scheduler` faz na VPS.
