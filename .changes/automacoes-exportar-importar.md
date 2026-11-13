---
impacto: capacidade_nova
secao: adicionado
titulo: Exportar e importar automação
---

Cada automação ganhou o botão "Exportar", na lista e no editor, que baixa um arquivo `.automacao.json` com o gatilho, as condições, as caixas, as ligações, os textos e as esperas. O arquivo nunca leva valor de chave secreta, texto escrito num cabeçalho de credencial nem e-mail de ninguém; etapa, funil, canal, pessoa, fonte de captação, chave e outra automação saem pelo nome. O botão "Importar" lê o arquivo, mostra o que vai ser criado e pede, para cada item citado, o que corresponde na conta de destino (já sugerido quando o nome bate). A automação importada nasce desligada, como rascunho, para revisar e publicar. Arquivo inválido ou adulterado é recusado inteiro, com a lista do que está errado. Por token (`dsk_…`), as mesmas operações estão em `GET /api/v1/automacoes/:id/exportar` e `POST /api/v1/automacoes/importar`. Não é preciso mudar nada.
