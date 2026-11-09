---
impacto: capacidade_nova
secao: alterado
titulo: MCP, API com chave e fontes de dados seguem o plano
---

O servidor MCP passa a responder só nos planos Max e Scale, com o limite de requisições por minuto de cada plano (30 no Max, 60 no Scale). A API com chave de acesso (`dsk_`) passa a responder só nos planos Max e Scale; no Pro a chamada com chave é recusada com o código `plano_sem_api`, e a tela de chaves mostra "Disponível no Max" no lugar do botão de criar. As chaves já criadas não são apagadas. Cada fonte de dados (webhook de entrada) aceita por minuto o que o plano diz: 60 no Pro e no Max, 120 no Scale. O limite é por fonte, não por empresa: uma fonte que recebe muito movimento não atrapalha as outras. O provisionamento por API passa a devolver `api_key_warning: "plano_sem_api"` quando o plano da empresa nova não inclui API nem MCP. O uso pela tela, com login, não muda.
