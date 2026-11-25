# Configuração da empresa: motivos de perda e campos por funil (migration 1021)

Prova pela tela, com o Playwright dirigindo o navegador, no banco de desenvolvimento
do homolog. Empresa de teste nova (`config-empresa-prova`), usuária admin, dois funis
(A e B), dois campos de negócio da empresa ("Origem da prova" e "Orçamento da prova").

## (a) Motivo de perda cadastrado na empresa aparece no funil

- `01-motivos-da-empresa-salvos.png`: Configurações › Motivos de perda com dois motivos
  da empresa. O aviso é "Nada mudou." porque esta captura vem da segunda rodada; a
  primeira gravou e mostrou "Motivos de perda salvos.".
- `02-dialogo-de-perda-funil-a.png` e `02-dialogo-de-perda-funil-b.png`: o diálogo
  "Marcar como perdido" dos dois funis oferece os motivos da empresa e "Outro motivo".
- `03-negocio-a1-perdido-com-motivo-da-empresa.png`: o Negócio A1 saiu do quadro. No
  banco ficou `status = lost` e `lost_reason = 'Preço alto da prova'`, aceito pelo gatilho
  `fn_validate_lost_reason_required`.

## (b) O funil escolhe quais campos usa

- `04-funil-a-escolhe-campos.png`: "Campos do negócio neste funil" no Funil A, com
  "Orçamento da prova" desmarcado.
- `05-funil-a-salvo.png`: o funil salvo. No banco ficou `settings.campos_visiveis = ["origem_prova"]`.
- `06-negocio-do-funil-a-campos.png`: o negócio do Funil A mostra só "Origem da prova".
- `06-negocio-do-funil-b-campos.png`: o negócio do Funil B continua mostrando os dois
  campos. O valor de "Orçamento da prova" continua gravado nos negócios do Funil A.

## (c) "Outro motivo" segue funcionando

- `07-outro-motivo-com-detalhe.png`: "Outro motivo" com detalhe, numa empresa que tem
  motivos próprios.
- `08-negocio-a2-perdido-outro-motivo.png`: o Negócio A2 foi perdido. A linha do tempo
  mostra "Perdido — Outro motivo: Cliente mudou de cidade (prova)". No banco ficou
  `lost_reason = 'other'`, com o detalhe na atividade `demand_closed`.
