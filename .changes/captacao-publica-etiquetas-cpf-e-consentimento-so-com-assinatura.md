---
impacto: exige_acao
secao: alterado
titulo: Etiquetas, CPF e consentimento enviados ao endereço de captação só valem com a assinatura da fonte
---

O endereço de captação (o link que recebe leads de formulário, Respondi, RD Station
ou do seu próprio servidor) é público: o código dele está no HTML da página, e
qualquer pessoa que o conheça consegue mandar um envio. Por isso três campos que
mudam a vida de um contato agora só entram quando o CRM tem prova de quem mandou:

- **`tags`** (etiquetas, que podem acionar automações);
- **`cpf`** (ou `cpf_cnpj`), que passa a ser gravado só com a assinatura, inclusive em
  contato que nasce naquele mesmo envio (antes valia para contato novo);
- o **consentimento** do formulário (Respondi), sobre contato que já existia.

A prova é a assinatura da fonte: o envio leva o cabeçalho `X-HiperCRM-Signature` com o
HMAC-SHA256, em hexadecimal, do corpo exatamente como foi enviado, usando o segredo da
fonte. O formato não mudou (o cabeçalho antigo `X-Deskcomm-Signature` segue aceito).

Sem a assinatura o lead e o contato entram normalmente, mas esses campos são
descartados — e agora isso aparece: a resposta 200 traz `data.ignored_fields` (por
exemplo `["tags", "cpf"]`), e o motivo fica no registro de operação do servidor. Antes
o descarte era silencioso.

## Requer atenção

Quem manda `tags`, `cpf` ou consentimento para uma fonte de captação precisa assinar o
envio: abra a fonte em Webhooks, copie o segredo e calcule o HMAC-SHA256 hexadecimal do
corpo cru no cabeçalho `X-HiperCRM-Signature`. Fonte sem segredo (formulário público de
site) continua recebendo leads, mas deixa de gravar etiqueta, CPF e consentimento; para
esses campos, mande o envio pelo seu servidor, com a fonte protegida por segredo. Quem
já assina não precisa mudar nada.
