---
impacto: capacidade_nova
secao: alterado
titulo: O cadastro guarda o ciclo escolhido na página de preços
---

Quem clica em assinar na página de preços com o ciclo Semestral ou Anual marcado chega à tela de pagamento com esse ciclo já selecionado, em vez de voltar ao Mensal. O link aceita `?ciclo=monthly|semiannual|yearly`; outro valor é ignorado. No provisionamento pela API, quando não dá para confirmar se o plano inclui API, a resposta traz `api_key_warning: "plano_nao_confirmado"`. Não é preciso mudar nada.
