---
impacto: capacidade_nova
secao: alterado
titulo: Cada chave secreta das automações só vai para os endereços que você permitir
---

Em Automações › Chaves secretas, cada chave agora tem a lista de endereços permitidos (por exemplo, api.servico.com.br). O bloco Requisição HTTP só manda a chave para esses endereços: se o bloco apontar para outro servidor, a publicação avisa e a execução sai por "Falhou" com a frase "A chave … só pode ser enviada para …", sem enviar nada. Chave nova pede pelo menos um endereço. Para incluir um endereço novo numa chave, é preciso colar a chave de novo. As chaves que já existiam continuam funcionando para qualquer endereço, e a tela mostra o aviso "Esta chave pode ser enviada para qualquer endereço. Informe o endereço do serviço."; recomendamos preencher o endereço de cada uma. A atualização normal aplica a mudança.
