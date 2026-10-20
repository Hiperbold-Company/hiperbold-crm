---
impacto: exige_acao
secao: alterado
titulo: A IA da chave da instalação passa a sair sempre pela OpenRouter, com o Luna como modelo padrão
---

Toda chamada de IA que roda na chave da instalação (a que desconta dos tokens do plano) agora sai
pela OpenRouter, com `OPENROUTER_API_KEY`: o atendimento, os classificadores, a leitura de imagem
e o preparo do material da base de conhecimento (embeddings). Elas nunca vão direto à OpenAI nem à
Anthropic, mesmo que `OPENAI_API_KEY` ou `ANTHROPIC_API_KEY` estejam no servidor. Os embeddings têm
plano B: se a OpenRouter falhar (rede, 4xx ou 5xx, menos 401) e houver `OPENAI_API_KEY`, tenta a
OpenAI direto uma vez e deixa o aviso no log. O registro de uso (`llm_calls`) passa a gravar
`openrouter` como provedor dessas chamadas, e a contagem dos tokens do plano continua igual.

- Organização nova já nasce com OpenRouter e o primeiro modelo de `MODELOS_DA_INSTALACAO` (Luna). Agente
  novo sem chave própria também. Agente já existente que aponta para um modelo Claude continua rodando
  em Luna (o freio de custo troca na hora), mas vale trocar o modelo dele na tela.
- No formulário do agente, o campo "Empresa de inteligência artificial" lista só "Chave própria do
  Hiperbold CRM (OpenRouter)" e os provedores que a empresa conectou. O servidor recusa, ao salvar e ao
  publicar, outro provedor ou modelo na chave do plano. A tela de chaves ganhou o cartão fixo "Incluída
  no seu plano".
- Na tela de agentes, quem usa a chave da instalação vê só os modelos liberados. A variante `:batch` da
  OpenRouter (lote, assíncrona) não é mais oferecida a agente nenhum, e o cartão do agente passa a mostrar
  o modelo da versão publicada (ou do rascunho, se nada foi publicado) em vez do cadastro antigo.

## Requer atenção

- Confira que `OPENROUTER_API_KEY` está preenchida no servidor. Sem ela, a IA da instalação para com o
  aviso de "sem chave" em vez de cair para outro provedor. Quem cadastra a própria chave em "Usar minha
  própria chave de IA" continua usando o provedor que escolheu.
- Mantenha `OPENAI_API_KEY` no servidor: a transcrição de áudio (Whisper), a ligação por voz (OpenAI
  Realtime) e o plano B dos embeddings continuam usando a OpenAI direto.
- Agente salvo com Anthropic ou OpenAI na chave da instalação não salva nem publica até trocar para
  "Chave própria do Hiperbold CRM (OpenRouter)" (ou conectar a chave da empresa).
