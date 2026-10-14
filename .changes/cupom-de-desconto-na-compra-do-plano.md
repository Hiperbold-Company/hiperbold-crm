---
impacto: capacidade_nova
secao: adicionado
titulo: Cupom de desconto na compra do plano
---

Quem assina um plano pode digitar um código de cupom e ver o valor com desconto
antes de confirmar. O desconto vale só na primeira cobrança: as renovações da
assinatura seguem no preço cheio do ciclo. Ele pode ser em porcentagem (de 1 a
99) ou em valor fixo, nunca passa de 99% do preço e o total nunca fica abaixo de
R$ 5,00. No cartão parcelado, os juros são calculados sobre o preço já
descontado e cada parcela precisa ficar em pelo menos R$ 5,00; se o desconto
deixar a parcela abaixo disso, a tela pede menos parcelas.

Cada cupom pode ter planos e ciclos permitidos, validade, limite total de usos
e pode ser ativado ou desativado. Uma empresa, e também um mesmo CPF ou CNPJ de
pagador, usa o mesmo cupom uma vez só. Cupom não vale para pacote de tokens.

Quem administra a plataforma cria e liga ou desliga cupons e vê quantas vezes
cada um foi usado. Todo código que não se aplica à compra (inexistente,
desativado, vencido, esgotado ou de outro plano) recebe a mesma mensagem, e as
tentativas de cupom têm limite por usuário, por empresa e por origem.

A mudança de banco (`0955`) vem junto com a atualização; nada a configurar.
Sem cupom, a compra funciona como antes.
