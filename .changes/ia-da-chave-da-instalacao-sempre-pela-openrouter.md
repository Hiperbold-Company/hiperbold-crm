---
impacto: exige_acao
secao: alterado
titulo: A IA da chave da instalação sai sempre pela OpenRouter, com o Luna como modelo padrão
---

Atendimento, classificadores, leitura de imagem e embeddings na chave da instalação usam
`OPENROUTER_API_KEY`, nunca a OpenAI ou a Anthropic direto. Embeddings têm plano B na OpenAI quando a
OpenRouter falha. Organização e agente novos nascem em Luna; agente com modelo Claude roda em Luna. O
formulário do agente só oferece a chave do plano e as chaves conectadas, e o servidor recusa outro
modelo na chave do plano. A variante `:batch` não é mais oferecida.

## Requer atenção

- Preencha `OPENROUTER_API_KEY` no servidor; sem ela a IA da instalação para com o aviso de "sem chave".
- Mantenha `OPENAI_API_KEY`: transcrição, voz e o plano B dos embeddings usam a OpenAI direto.
