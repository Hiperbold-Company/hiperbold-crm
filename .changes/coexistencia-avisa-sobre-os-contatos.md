---
impacto: exige_acao
secao: corrigido
titulo: Coexistência avisa sobre os contatos e permite trazer de novo
---

Na conexão em coexistência, a tela agora avisa que os contatos e as conversas dos últimos 6 meses
do WhatsApp Business do número vão aparecer no CRM para a equipe, e só abre a Meta depois de a
pessoa marcar que concorda. Se a Meta não trouxer os contatos no momento da conexão, a tela diz isso
e oferece o botão "Tentar de novo", em vez de mostrar só "Conectado".

## Requer atenção

- A resposta pública de saúde da instalação deixou de trazer o identificador do commit; a versão
  continua nela. Se um monitor ou script seu lê o commit nessa resposta, ele passa a não encontrá-lo.
- Uma conexão oficial existente não troca mais de número: reenviar a conexão com um número diferente
  do dela é recusado (422, `numero_diferente_da_conexao`). Para usar outro número, conecte-o como uma
  conexão nova; a antiga continua como está até você removê-la.
