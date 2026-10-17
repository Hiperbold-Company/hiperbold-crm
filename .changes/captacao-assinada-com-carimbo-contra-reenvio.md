---
impacto: capacidade_nova
secao: adicionado
titulo: Captação assinada aceita carimbo de horário e passa a recusar envio reenviado
---

O endereço de captação com segredo agora aceita, junto da assinatura, o cabeçalho
`X-HiperCRM-Timestamp` (segundos Unix). Com ele, a assinatura em `X-HiperCRM-Signature`
é o HMAC-SHA256 hexadecimal de `v1:carimbo.corpo` (as letras `v1:`, o carimbo, um ponto
e o corpo exatamente como foi enviado), e o CRM recusa o envio quando o carimbo difere
do relógio do servidor em mais de 5 minutos. Assim, um envio assinado que alguém
capturou deixa de poder ser reenviado depois.

Nada muda para quem já assina só o corpo: a fonte segue aceitando esse formato até
receber o primeiro envio válido com carimbo. A partir daí ela passa a exigir o carimbo
e recusa o formato antigo. Não há chave para ligar nem desligar, e o banco não deixa
desligar a exigência depois que ela liga.

Também nesta versão:

- Se o segredo de uma fonte não puder ser aberto (a chave da instalação está ausente ou
  foi trocada), a captação responde 503 e registra a recusa no histórico, em vez de
  aceitar o envio como se a fonte fosse pública.
- O número do CPF guardado nos contatos deixa de ser legível ou gravável por quem usa a
  API do banco diretamente com a sessão de um usuário; o CRM continua mostrando se o
  contato tem CPF.
- Gravar o CPF de um contato pela tela, pela API de contatos ou pela importação de
  planilha passa a funcionar (antes falhava por falta da função de cifra), e quem tem
  papel de gerente ou acima volta a conseguir abrir o CPF de um contato.
