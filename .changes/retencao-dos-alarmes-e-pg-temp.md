---
impacto: nada_mudou
secao: alterado
titulo: Funções do banco com caminho de busca fechado e prazo para os alarmes de contagem
---

As funções do banco que rodam com privilégio elevado agora terminam o caminho de busca em `pg_temp`, para que um objeto temporário nunca seja encontrado no lugar do original. Os alarmes da contagem de negócios passam a ser apagados depois de 90 dias, pela rotina diária de retenção. O prazo pode ser aumentado com `BILLING_TRIGGER_ALARM_RETENTION_DAYS`, mas nunca fica abaixo de 90. Nada muda para quem não define a variável.
