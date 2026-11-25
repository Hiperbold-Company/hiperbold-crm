---
impacto: nada_mudou
secao: corrigido
titulo: "Nova etiqueta" não perde etiqueta quando duas pessoas criam ao mesmo tempo
---

Ao criar etiquetas em Configurações › Etiquetas, se duas pessoas (ou duas abas) criassem uma etiqueta quase no mesmo instante, a segunda podia apagar a primeira. Agora cada criação é gravada de forma atômica no banco e nenhuma se perde. A atualização aplica uma migration no banco; não é preciso mudar nada à mão.
