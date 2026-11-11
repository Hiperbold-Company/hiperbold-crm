# Análise do app na Meta: Instagram Direct, Messenger e WhatsApp

Roteiro da primeira análise do app **Hiperbold CRM** (id 803080829518569), feita para o atendimento por mensagens. Os comentários (`instagram_manage_comments`, a automação estilo ManyChat) ficam para a segunda análise, quando o fluxo estiver pronto. O WhatsApp oficial tem análise própria (seção 7).

Sem esta análise, só quem tem função no app (administrador, desenvolvedor ou testador) consegue conectar o Instagram ou a Página e trocar mensagens. Os clientes do CRM dependem dela.

## 1. O que pedir

Peça acesso avançado a estas 7 permissões. Todas estão na configuração `hiperbold_crm_instagram` (1725898772272661):

| Permissão                   | Para que o CRM usa                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `instagram_basic`           | Ler o nome de usuário e o id da conta profissional que o cliente conecta             |
| `instagram_manage_messages` | Receber as mensagens do Direct no Chat e responder por ele                           |
| `pages_show_list`           | Listar as Páginas do cliente para achar a conta do Instagram ligada a cada uma       |
| `pages_manage_metadata`     | Inscrever a Página no webhook do app (`subscribed_apps`), para as mensagens chegarem |
| `pages_messaging`           | Receber e responder as mensagens do Messenger da Página                              |
| `pages_read_engagement`     | Ler o nome e a foto de quem manda mensagem para a Página                             |
| `business_management`       | Ler as Páginas e as contas do Instagram que estão dentro de um portfólio de negócios |

Não peça agora: `instagram_manage_comments` (segunda análise), `instagram_content_publish`, `ads_management` e `ads_read`. O CRM não usa nenhuma delas neste fluxo, e pedir permissão sem uso é o motivo de recusa mais comum.

O `public_profile` já tem acesso avançado (concedido em 03/11/2026).

## 2. Antes de enviar (checklist)

- [ ] **Verificação da empresa** concluída no portfólio Hiperbold Company (Configurações do negócio › Central de segurança). A Meta exige isso para acesso avançado.
- [ ] **Configurações do app › Básico**:
  - ícone 1024×1024;
  - categoria "Negócios e páginas";
  - e-mail de contato.
- [ ] **URLs públicas**, todas respondendo 200 em 03/11/2026:
  - Política de privacidade: `https://crm.hiperbold.com.br/legal/privacy`
  - Termos de uso: `https://crm.hiperbold.com.br/legal/terms`
  - Exclusão de dados: `https://crm.hiperbold.com.br/exclusao-de-dados`
- [ ] **Conta para o revisor no CRM**: um usuário só para a Meta (por exemplo `revisao-meta@hiperbold.com.br`), na organização Hiperbold Company, com papel `admin`.
  - A senha vai **só** no campo de instruções da análise, nunca em arquivo nem em chat.
  - **Não apague a conta depois da análise:** o Checkup de Uso de Dados (revisão anual da Meta) pede que as credenciais de teste fiquem ativas por 1 ano a partir do envio.
- [ ] **A aba Conexões › Redes sociais precisa aparecer para o revisor.** Hoje ela está oculta para todos, exceto o administrador da plataforma e as organizações com acesso antecipado (`lib/hiperbold/funcoes-ocultas.ts`: Hiperbold Company e o tenant do revisor, "Meta Developers"). Sem isso, o revisor não vê a tela que o vídeo mostra (ver a seção 6).
- [ ] O @hiperbold e a Página Hiperbold Company **conectados** no CRM (já estão, desde 03/11/2026).
- [ ] O app em modo **Ao vivo** (já está).

## 3. Texto de cada permissão (colar em inglês no formulário)

A Meta pede, para cada permissão, "como o app usa" e "passo a passo para testar". O mesmo vídeo serve para todas: o formulário aceita repetir o arquivo.

**instagram_basic**

> Hiperbold CRM is a customer service CRM for businesses. When a business connects its Instagram professional account in Connections › Social networks, we use instagram_basic to read the account's ID and username so we can show which account is connected and route its Direct messages to the right workspace. We do not read or store media.

**instagram_manage_messages**

> We use instagram_manage_messages to receive the Instagram Direct messages that customers send to the business and to let the business's agents reply from the CRM Chat. Messages are only sent as replies inside the 24-hour window started by the customer. The business can disconnect the account at any time, which stops message delivery.

**pages_show_list**

> To connect Instagram and Messenger, we list the Facebook Pages the person manages so we can find the Instagram professional account linked to each Page and let them connect the Page itself to Messenger.

**pages_manage_metadata**

> After the business connects a Page, we subscribe the app to that Page's webhooks (POST /{page-id}/subscribed_apps) so that new Messenger and Instagram messages reach the CRM. When the business disconnects, we remove the subscription.

**pages_messaging**

> We use pages_messaging to receive the messages people send to the business's Facebook Page through Messenger and to let the business's agents reply from the CRM Chat, within the standard 24-hour messaging window.

**pages_read_engagement**

> We read the name and profile picture of the person who messages the Page, so agents know who they are talking to in the CRM Chat.

**business_management**

> Many of our customers keep their Pages and Instagram accounts inside a Meta business portfolio. We use business_management only to read the Pages and Instagram accounts the person selected in that portfolio during login, so they can be connected. We do not create, edit or delete any business assets.

**Instruções para o revisor (campo geral)**

> 1. Go to https://crm.hiperbold.com.br and log in with the test account below.
> 2. Open Connections › Social networks. The Instagram account @hiperbold and the Page "Hiperbold Company" are already connected. To see the login flow, click Connect on Instagram Direct or Facebook Messenger.
> 3. From any Instagram account, send a Direct message to @hiperbold. From any Facebook account, send a message to the Page "Hiperbold Company".
> 4. Open Chat in the CRM. The message appears in the list within a few seconds, with the Instagram or Messenger icon.
> 5. Type a reply and send it. The reply is delivered in Instagram Direct or Messenger.
>    Test account: [e-mail] / [senha] (preencher na hora de enviar)

## 4. Roteiro do vídeo

Um vídeo só, de 3 a 4 minutos, sem áudio. Grave a tela com o CRM em **inglês** (botão PT, no topo, troca para EN) e o Facebook em inglês. Mostre sempre a barra de endereço, porque a Meta confere o domínio.

| #   | Tempo | O que aparece na tela                                                                                                             | Legenda (em inglês)                                                                                                                                                                         |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0:00  | Tela de login do CRM em `crm.hiperbold.com.br`; entrar com a conta de teste                                                       | "Logging in to Hiperbold CRM"                                                                                                                                                               |
| 2   | 0:15  | Menu › Connections › aba Social networks, com Instagram Direct e Facebook Messenger                                               | "Connections › Social networks"                                                                                                                                                             |
| 3   | 0:25  | Clicar **Disconnect** no @hiperbold e depois **Connect** no Instagram Direct                                                      | "Connecting an Instagram professional account"                                                                                                                                              |
| 4   | 0:35  | Janela da Meta: escolher o portfólio, a Página Hiperbold Company e o @hiperbold; mostrar a tela das permissões pedidas; confirmar | "Meta login: the business selects the Page and the Instagram account and grants pages_show_list, business_management, instagram_basic, instagram_manage_messages and pages_manage_metadata" |
| 5   | 1:05  | De volta ao CRM: aviso "Account connected" e o cartão com @hiperbold                                                              | "instagram_basic: the CRM shows the connected account's username"                                                                                                                           |
| 6   | 1:15  | No celular ou em outra janela, de outra conta, mandar um Direct para o @hiperbold                                                 | "A customer sends an Instagram Direct message"                                                                                                                                              |
| 7   | 1:30  | No CRM, Chat: a conversa aparece com o ícone do Instagram; abrir                                                                  | "instagram_manage_messages: the message arrives in the CRM Chat"                                                                                                                            |
| 8   | 1:45  | Escrever uma resposta e enviar; mostrar a resposta chegando no Direct do outro lado                                               | "The agent replies from the CRM and the customer receives it in Instagram"                                                                                                                  |
| 9   | 2:05  | Voltar a Connections; clicar **Connect** no Facebook Messenger; escolher a Página; confirmar                                      | "Connecting the Facebook Page for Messenger (pages_messaging, pages_manage_metadata)"                                                                                                       |
| 10  | 2:30  | De um perfil do Facebook, mandar mensagem para a Página                                                                           | "A customer messages the Page on Messenger"                                                                                                                                                 |
| 11  | 2:45  | No Chat: a conversa com o ícone do Messenger, o nome e a foto de quem mandou                                                      | "pages_read_engagement: name and picture of the sender"                                                                                                                                     |
| 12  | 2:55  | Responder pelo CRM e mostrar a resposta no Messenger                                                                              | "pages_messaging: reply delivered in Messenger"                                                                                                                                             |
| 13  | 3:15  | Clicar **Disconnect** no Messenger e mostrar o cartão sem conta                                                                   | "The business can disconnect at any time; the webhook subscription is removed"                                                                                                              |

**Como gravar no Mac:** Cmd+Shift+5 › "Gravar a tela inteira" (ou a janela do navegador) › Gravar. Para parar, clique no botão ⏹ na barra de cima. Use resolução 1080p e grave sem cortes; as legendas entram depois.

Grave sem legendas. Me mande o arquivo e eu coloco as legendas da tabela no vídeo, em inglês, e devolvo pronto para subir.

## 5. Depois de enviar

- A análise costuma levar de 2 a 10 dias úteis. A resposta chega em Análise do app › Solicitações e no e-mail do administrador.
- Se a Meta recusar uma permissão, a recusa traz o motivo. Ajustamos o texto ou o vídeo só daquela permissão e reenviamos.
- Aprovado: libere a aba Redes sociais para os clientes (a conta de revisor fica ativa por 1 ano, por causa do Checkup de Uso de Dados). Depois disso, peça ao chat `hiperbold-ajuda` o artigo de como conectar o Instagram e o Messenger.

## 6. Decisão pendente: a aba Redes sociais para o revisor

O revisor entra como um usuário comum, e a aba está oculta para usuário comum. Há três caminhos:

1. **Mostrar a aba só na organização Hiperbold Company (recomendado).** É uma mudança pequena no código. Os clientes continuam sem ver a aba até a aprovação, porque sem ela não conseguiriam conectar.
2. Mostrar a aba para todos já. Os clientes veriam uma função que ainda não funciona para eles.
3. Dar ao revisor o papel de administrador da plataforma. Isso dá poder demais para uma conta de fora, e não recomendo.

## 7. Análise do WhatsApp (separada)

Sim, o WhatsApp oficial (WABA) também precisa de acesso avançado, mas numa análise própria, depois desta.

**Por que separada:** acesso padrão já basta para o número da própria Hiperbold, porque a WABA é do mesmo portfólio do app. É o que roda hoje, com o token do usuário do sistema. O acesso avançado é necessário para o CRM operar a WABA de **outro negócio**, ou seja, do assinante. E isso só acontece pelo Cadastro Incorporado (Embedded Signup), que ainda não existe no CRM (D-172). Sem esse fluxo pronto, não há o que mostrar no vídeo, e a Meta recusa.

**O que pedir:**

| Permissão                        | Para que o CRM usa                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `whatsapp_business_messaging`    | Receber as mensagens do WhatsApp do assinante no Chat e responder por ele                  |
| `whatsapp_business_management`   | Ler a WABA e o número do assinante, inscrever o app no webhook e gerenciar os modelos (templates) |
| `business_management`            | Já pedida na primeira análise; serve também para ler a WABA dentro do portfólio            |

**Pré-requisitos, nesta ordem:**

1. A primeira análise (Instagram e Messenger) aprovada. Ela já resolve a verificação da empresa e as URLs públicas.
2. A Hiperbold cadastrada como **Provedor de Tecnologia** (Tech Provider) no app. O caminho é Painel do app › WhatsApp › Primeiros passos › "Tornar-se um provedor de tecnologia".
3. O D-172 implementado: botão Conectar em Conexões › API Oficial (Meta), com login do Facebook, escolha do número e **coexistência**. Coexistência quer dizer que o mesmo número continua no aplicativo WhatsApp Business. É regra fixa do projeto.
4. Uma configuração de Login do Facebook para Empresas (`config_id`) só para o WhatsApp, com as duas permissões acima.

**Roteiro do vídeo (quando o D-172 estiver pronto):**

1. Login no CRM, depois Connections › Official API (Meta).
2. Clicar Connect. Na janela da Meta, escolher o portfólio, a WABA e o número, já em uso no WhatsApp Business, e confirmar as permissões.
3. Voltar ao CRM e mostrar o número conectado.
4. De outro celular, mandar uma mensagem para o número. A conversa chega no Chat com o ícone do WhatsApp.
5. Responder pelo CRM e mostrar a resposta chegando no WhatsApp.
6. Abrir Templates, criar um modelo e mostrar o envio para aprovação (`whatsapp_business_management`).
7. Desconectar e mostrar o cartão sem número.

Os textos de cada permissão, em inglês, entram aqui quando o D-172 estiver pronto, porque eles descrevem a tela como ela ficou.
