# Comentários do Instagram: o contrato do canal

Para quem constrói as Automações. O canal do Instagram (provider `meta_social`)
recebe o comentário, avisa que ele chegou e oferece três ações. Ele **não decide
nada**: responder ou não, o quê, quando, e o que exigir da pessoa é decisão de
cada automação.

Código: `lib/channels/meta-social/comentarios.ts` (entrada e ações),
`lib/channels/meta-social/fila.ts` (envio), `lib/channels/meta-social/comentarios-contrato.ts`
(vocabulário, tipos e limites). Banco: migration 0991.

---

## 1. O evento: `instagram.comentario_recebido`

Cada comentário **novo** vira **uma** linha em `event_log`, na mesma transação
em que é gravado em `meta_social_comentarios`. A Meta reentrega avisos; a
reentrega não cria linha nem evento novo.

| Coluna do `event_log` | Valor |
|---|---|
| `event_type` | `instagram.comentario_recebido` |
| `entity_kind` | `instagram_comment` |
| `entity_id` | `meta_social_comentarios.id` |
| `organization_id` | a organização dona da conta (sai da sessão, nunca do corpo do aviso) |
| `metadata` | `{ "actor_kind": "system", "source": "webhook/meta-social" }` |

O evento nasce `pending` e **nenhum consumidor o lê ainda**: o dreno genérico só
pega tipo com handler registrado. O consumidor é a automação.

O `payload` (tipo `EventoComentarioRecebido`), snake_case, datas em ISO-8601 UTC:

| Campo | Tipo | O que é |
|---|---|---|
| `organization_id` | uuid | a organização (a mesma da coluna) |
| `channel_session_id` | uuid | a conexão do Instagram que recebeu |
| `comment_id` | texto | id do comentário na Meta. **É o que as ações recebem.** |
| `media_id` | texto ou null | o post ou reel comentado |
| `media_product_type` | texto ou null | ex.: `FEED`, `REELS` (como a Meta mandar) |
| `autor_id` | texto | IGSID de quem comentou (ver a seção 4) |
| `autor_usuario` | texto ou null | @ de quem comentou, sem a arroba |
| `texto` | texto ou null | o comentário (a Meta só manda se tiver texto) |
| `criado_na_meta_em` | ISO-8601 ou null | hora do **aviso** da Meta (`entry.time`); a hora exata do comentário não vem no aviso |

A linha do comentário (`meta_social_comentarios.id`) é o `entity_id` do evento.

Exemplo:

```json
{
  "organization_id": "0c9a7d2e-1b3f-4c5d-8e6f-7a8b9c0d1e2f",
  "channel_session_id": "b7a1c9de-5f0e-4a8e-8b7d-1c2e3f4a5b6c",
  "comment_id": "17958276893123456",
  "media_id": "18034567890123456",
  "media_product_type": "REELS",
  "autor_id": "6543210987654321",
  "autor_usuario": "maria.silva",
  "texto": "QUERO",
  "criado_na_meta_em": "2026-11-03T12:00:00.000Z"
}
```

**Que comentários viram evento:** só os de primeiro nível, em post ou reel, de
outra pessoa. Ficam de fora, sem evento:

- comentário da própria conta (é a nossa resposta pública voltando);
- resposta a outro comentário (`parent_id` presente);
- comentário em live (`live_comments`): a resposta privada só vale durante a transmissão;
- comentário em Página do Facebook (outro objeto do webhook).

---

## 2. As três ações

Todas recebem a organização **já resolvida de fonte confiável** (a execução da
automação, a sessão do usuário). Nunca a tirem de corpo de requisição. Toda
consulta filtra por ela: comentário ou sessão de outra organização se comporta
como inexistente.

O primeiro parâmetro é o client de service role (`createAdminClient()`); o
último, opcional, é `{ agora?, fetcher? }`, para teste.

### 2.1 `pedirRespostaPrivada(admin, { organizationId, commentId, texto, pedidoPor })`

`Promise<{ status: "na_fila" | "ja_pedida" | "expirada" | "nao_encontrado" }>`

Manda uma mensagem no **Direct** de quem comentou. Vai para a fila; o cron envia.

| Retorno `status` | Quando |
|---|---|
| `na_fila` | aceito; sai na próxima rodada do cron (de minuto em minuto), no ritmo da conta |
| `ja_pedida` | já houve um pedido de resposta privada para este comentário (qualquer desfecho). **Só existe uma por comentário.** |
| `expirada` | o comentário tem 7 dias ou mais |
| `nao_encontrado` | o comentário não existe nesta organização |

`pedidoPor` é livre (até 200 caracteres): use o id da execução da automação.

Erros (lança `Error`): `meta_social_texto_invalido` quando o texto é vazio ou
passa de 1000 bytes UTF-8 (nada entra na fila); `meta_social_comment_lookup_failed`
e `meta_social_queue_insert_failed` em falha do banco.

### 2.2 `responderNoComentario(admin, { organizationId, commentId, texto, pedidoPor })`

`Promise<{ status: "na_fila" | "ja_pedida" | "nao_encontrado" }>`

Responde **em público**, no próprio comentário. Também pela fila.

Retornos: `na_fila`, `ja_pedida` (uma pública por comentário), `nao_encontrado`.
Erros: os mesmos da 2.1.

**Ordem:** o cron só envia a pública depois que a privada do mesmo comentário
saiu, falhou ou expirou. Se não houver privada pedida **no momento em que o cron
olha**, a pública sai direto. Por isso: **peça a privada antes da pública**.

### 2.3 `conferirSeSegue(admin, { organizationId, channelSessionId, autorId })`

`Promise<{ segue: boolean | null }>`. Nunca lança.

Pergunta à Meta se a pessoa segue a conta. Chamada direta, sem fila, e **não
conta no teto** das respostas privadas.

| Retorno | Quando |
|---|---|
| `{ segue: true }` | segue |
| `{ segue: false }` | não segue |
| `{ segue: null }` | não deu para saber: a Meta recusou ou não respondeu, a sessão não é desta organização, está arquivada ou sem token |

⚠️ **A Meta só libera esta informação depois que a pessoa manda mensagem à conta**
(ou toca num ice breaker ou no menu). Quem só comentou devolve erro de
consentimento, e o retorno é `null`. Na prática: confira **depois** que a pessoa
responder a DM, nunca logo após o comentário. O que fazer com `null` é decisão
da automação.

Fonte: [User Profile API](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile)
(`GET /<IGSID>?fields=is_user_follow_business`, com o token da Página).

---

## 3. Limites e regras de ordem

| Regra | Valor | Fonte |
|---|---|---|
| Resposta privada por comentário | **1** | [Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies) |
| Prazo da resposta privada | **até 7 dias** da criação do comentário | idem |
| Limite da Meta | 750 respostas privadas por hora por conta | [Rate limiting](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting) |
| **Teto do CRM** | **600 respostas privadas por hora por conta** (os últimos 60 minutos), constante `TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA` | 20% de folga |
| Privada antes da pública | a pública espera a privada do mesmo comentário | regra de sistema em produção |
| Resposta pública por comentário | 1 | escolha do canal |

Como a fila se comporta:

- passou do teto: a resposta espera a vaga (quando a mais velha da janela fizer 60 minutos);
- a Meta disse "limite" (código 4, 17, 32, 613 ou HTTP 429): espera crescente (2, 4, 8 … até 60 minutos), **não é falha**;
- erro 2534025, ou o comentário fez 7 dias na fila: `expirada`;
- token recusado: a conexão passa a pedir "Reconectar" (o mesmo aviso do Direct) e a resposta espera 30 minutos;
- falha de rede: tenta de novo até 5 vezes, depois `falhou`;
- qualquer outro erro da Meta: `falhou`, com o código em `erro`;
- nada é enviado duas vezes: a linha é reservada (`enviando`) antes do envio; se o servidor cair no meio, ela vira `falhou` com `erro = envio_sem_confirmacao` depois de 10 minutos, **sem reenviar** (a DM pode ter saído).

Onde ler o desfecho:

- `meta_social_comentarios.resposta_privada_status`: `nao_pedida`, `na_fila`, `enviada`, `falhou`, `expirada`; mais `resposta_privada_mid`, `resposta_privada_erro`, `resposta_privada_em`, `resposta_publica_id`, `resposta_publica_em`;
- `meta_social_fila_de_envio.status`: `na_fila`, `enviando`, `enviada`, `falhou`, `expirada`; mais `erro`, `tentativas`, `resultado_id`, `enviada_em`.

O canal **não emite evento** quando a resposta sai ou falha. Quem precisar saber
lê as tabelas acima (ou pede o evento ao canal).

Nunca responda em público a todos os comentários: a Meta lê como spam.

---

## 4. Quando a pessoa responde a DM

A resposta chega pelo **fluxo normal do Direct**, que já existe: contato por
`contacts.social_identity` (`instagram:<conta>:<IGSID>`), conversa com
`conversations.provider_conversation_id = <IGSID>`, mensagem em `messages`, e
os efeitos de sempre (opt-out, lead, agente).

**O que liga a conversa ao comentário é o `autor_id`**, procurado como
`provider_conversation_id` da conversa (e fim da `social_identity` do contato)
na mesma conexão (`channel_session_id`).

`autor_id` é o mesmo IGSID que chega depois como remetente da DM?
- A doc chama os dois de IGSID: `from.id` do comentário é o "Instagram-scoped ID
  of the Instagram user who made the comment"
  ([exemplos de webhook](https://developers.facebook.com/docs/instagram-platform/webhooks/examples)),
  e `sender.id` da mensagem é o IGSID do Direct. A resposta da resposta privada
  devolve `recipient_id`, "the Instagram-scoped ID", para quem a DM foi.
- Que os dois são **o mesmo valor** para a mesma pessoa e a mesma conta:
  **NÃO CONFIRMADO NA DOC** (nenhuma página diz isso com todas as letras, e não
  foi medido em produção). Medir no primeiro caso real: comparar `autor_id` com o
  `provider_conversation_id` da conversa criada quando a pessoa responde.
- O canal hoje não guarda o `recipient_id` da resposta privada (só o `message_id`,
  em `resposta_privada_mid`).

Se a pessoa comentou em vários posts, o IGSID não diz qual comentário ela está
respondendo: a automação precisa guardar qual pediu.

A doc da Meta não diz se a mensagem da pessoa traz alguma referência ao
comentário (NÃO CONFIRMADO NA DOC). O CRM não lê nenhuma.

A DM que a resposta privada manda **não aparece** na conversa do CRM: o eco dela
é reconhecido como envio nosso (`meta_social_envios`) e descartado, para não
virar "respondido pelo celular" e pausar a IA. A conversa nasce quando a pessoa
responde.

A janela de 24 horas do Direct abre quando a pessoa responde. Antes disso, a
única mensagem possível é a resposta privada.

---

## 5. O que o canal NÃO faz (é da automação)

- conferir palavra-chave no comentário;
- decidir se responde, o quê, e com que intervalo;
- exigir que a pessoa siga o perfil e pedir o follow;
- esperar "quero", "pronto" ou qualquer resposta, e entregar o conteúdo;
- criar contato, negócio ou tarefa a partir do comentário;
- decidir se responde em público, e não fazer isso com todos;
- métricas e tela.

---

## 6. NÃO CONFIRMADO NA DOC (conferido em 03/11/2026)

- Resposta privada pelo token do usuário do sistema em `/<IG_ID>/messages` (conta sem Página): a doc só mostra `/<PAGE_ID>/messages` com o token da Página.
- Resposta pública com o token da Página: a doc pede token de usuário.
- O erro 2534025 (comentário inelegível) e os códigos de limite 4, 17, 32 e 613: a página de limites não lista código.
- A hora de criação do comentário no aviso: os exemplos não a trazem; usamos `entry.time` (que a doc mostra ora em segundos, ora em milissegundos).
- Se comentário da própria conta dispara o aviso; o canal ignora de qualquer forma.
- Se o campo `comments` assinado na Página basta para a conta conectada pela Página receber os comentários (a assinatura da Página usa os campos do Messenger). Na conta pelo login unificado, `comments` foi acrescentado aos campos assinados; **conta já conectada só passa a receber depois de reconectar**.
- O campo `comments` exige **Acesso Avançado** no app da Meta (revisão do app).
