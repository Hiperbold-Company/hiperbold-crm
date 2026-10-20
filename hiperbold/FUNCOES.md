# Funções do HiperCRM: ativas e ocultas

Decisão do Filipe (16/10/2026): **validar antes de lançar**. O que ainda não foi testado com cliente de verdade fica escondido nesta instalação. Nada foi apagado: o código, as rotas de API e os dados continuam onde estavam. Esconder é só deixar de mostrar a tela; não muda quem pode fazer o quê.

A lista de ocultas mora num único arquivo: [`lib/hiperbold/funcoes-ocultas.ts`](../lib/hiperbold/funcoes-ocultas.ts) (`FUNCOES_OCULTAS`). Menu lateral, "Ver tudo em …", Configurações, busca ⌘K e os blocos dentro das telas leem dali. Quem abrir o endereço de uma tela oculta cai no Início. O painel de plataforma (`/admin`) não é afetado.

## Como reativar uma função

1. Abra `lib/hiperbold/funcoes-ocultas.ts` e apague o id da função da lista `FUNCOES_OCULTAS` (a linha tem a data e o lugar onde ela morava).
2. Mova a linha daqui de "Funções ocultas" para "Funções ativas".
3. Nada mais muda: menu, hubs, busca e o redirecionamento do endereço voltam sozinhos.

## Funções ativas

| Função | Para que serve |
|---|---|
| Início | O que já está pronto e o que falta para o CRM trabalhar pela empresa. |
| Inbox | As conversas de WhatsApp, com a equipe e a IA atendendo lado a lado. |
| Radar | Quem esfriou e ainda está aberto. |
| Agenda e Tipos de agendamento | O que está marcado, com quem, e o que se pode marcar. |
| Respostas rápidas | Textos salvos para responder mais rápido. |
| Funis (quadro de clientes) e Etapas do funil | O funil de vendas em colunas. |
| Contatos | As pessoas e o histórico de cada uma. |
| Campanhas | Mensagem para uma lista de contatos, no ritmo do número. |
| Tarefas | O que ficou combinado, com prazo. |
| Produtos | Catálogo que o agente de IA usa para responder. |
| Agentes de IA, Follow-ups, Fluxos de atendimento, Roteadores | Quem atende por você e como retoma conversa que esfriou. |
| Conhecimento, Memória, Skills, Conexões MCP | O que o agente consulta e pode fazer. |
| Casos, Alertas, Aviso no WhatsApp, Propostas, Execuções, Uso e orçamento, Evolução da IA | Acompanhar o que a IA fez e decidir o que ela sugere. |
| Desempenho, Atividades, Faturamento | Números do período e quanto entrou. |
| Conexões WhatsApp: **UAZAPI** (QR Code) e **API Oficial (Meta)** | Por onde o negócio fala com o cliente. A opção que se chamava "API não oficial" passou a se chamar UAZAPI. |
| Webhooks (receber e enviar dados) | Avisar outros sistemas quando algo acontece, e receber dados de fora. |
| Nuvemshop | Trazer pedidos e clientes da loja. |
| Equipe, Distribuição de atendimento, Tags, Organização, Marca, LGPD, API Tokens, Audit Log, Notificações, Perfil, Segurança (verificação em duas etapas e sessões) | Configurações do dia a dia. |
| Membro da agência (painel de plataforma › tenant › "Membros da agência"; selo "Agência" na Equipe) | Acesso permanente da agência que opera o CRM do cliente: não ocupa vaga do plano, não sai quando o dono assume e o cliente não remove. Quem cria a organização para outra pessoa nasce assim (antes era provisório). Marcar e remover: só admin da plataforma `full`, pela função `fn_membro_da_agencia_definir` (migration 0974). |
| Meu plano | Plano contratado, pagamento, uso e cancelamento. |
| Jev — decisões rápidas | Um segundo modelo de IA, rápido e barato, que decide para onde mandar cada conversa (TypeSafe System One). Funciona com a chave da TypeSafe da Hiperbold no servidor (`JEV_API_KEY`); a empresa que cola a própria chave em Credenciais usa a dela. Tela própria em Configurações › IA › **Decisões rápidas (Jev)** (`/app/ai/jev`, a partir de gestor): é o mesmo cartão que morava em Provedores, que segue oculto. Precisa ser ligado e aceito por um administrador. O consumo do Jev na chave da instalação **não desconta dos tokens do plano**, mas é medido (origem `jev_da_instalacao` em `llm_calls`, migration 0960). |
| Modelos de IA do plano | Só os modelos liberados em `MODELOS_DA_INSTALACAO` (hoje: Luna) rodam na chave da instalação, a que desconta dos tokens do plano. Editável em /admin/configuracao; o primeiro da lista é o padrão. **A chave da instalação sai SEMPRE pela OpenRouter (`OPENROUTER_API_KEY`), nunca direto pela OpenAI nem pela Anthropic** (decisão de 20/10/2026): atendimento, classificadores, visão e embeddings da base de conhecimento (`openai/text-embedding-3-small`, 1536 dimensões; se a OpenRouter falhar, menos 401, e houver `OPENAI_API_KEY`, tenta a OpenAI direto uma vez); `llm_calls` grava `provider = openrouter`. Sem `OPENROUTER_API_KEY` a IA da instalação para com o erro de "sem chave" (não cai para outro provedor). Exceções, que seguem com `OPENAI_API_KEY` direto: a transcrição de áudio (Whisper; a rota da OpenRouter ainda não foi provada) e a ligação por voz (OpenAI Realtime). Organização e agente novos nascem em OpenRouter + Luna; na tela do agente, quem usa a chave da instalação vê só os modelos liberados (a variante `:batch`, assíncrona, nunca é oferecida), e o cartão mostra o modelo da versão publicada ou do rascunho. Quem usa a própria chave de IA escolhe qualquer modelo. No formulário do agente, o campo "Empresa de inteligência artificial" lista só "Chave própria do Hiperbold CRM (OpenRouter)" (modelos de `MODELOS_DA_INSTALACAO`, com a ajuda "Na chave do Hiperbold CRM, o uso desconta do limite do seu plano.") e os provedores que a empresa conectou em "Usar minha própria chave de IA"; a OpenRouter da empresa aparece como "OpenRouter (sua chave)". Agente salvo em par que o plano não permite mostra "não disponível no seu plano; escolha outro" e não salva nem publica; o servidor recusa o mesmo (`provider_not_allowed`, `model_not_allowed`). |
| **Usar minha própria chave de IA (avançado)** (antes "Credenciais") | Para quem quer usar outro modelo (Grok, Claude, Gemini…) com a própria conta do OpenRouter. O consumo nessa chave não desconta dos tokens do plano. Ativa e **avançada**: fica só em Configurações › IA (decisão do Filipe, 16/10/2026), fora do "Ver tudo em IA". O cliente comum não precisa dela: o agente usa a chave da instalação. Na tela, o cartão fixo **"Chave própria do Hiperbold CRM (OpenRouter)"** (selo "Incluída no seu plano", "O uso desconta do limite de tokens do seu plano.") aparece no topo quando o servidor tem `OPENROUTER_API_KEY`; não é linha de credencial, então não tem Modelos, Em uso por, editar, atualizar nem excluir, e nunca mostra dígitos da chave. As chaves que a empresa cadastra seguem com tudo, e a OpenRouter dela aparece como "OpenRouter (sua chave)". |

## Funções ocultas

Todas: **16/10/2026, decisão do Filipe: validar antes de lançar.** Id é o nome na lista do arquivo.

| Id | O que é (em português simples) | Onde morava |
|---|---|---|
| `prospeccao` | Buscar empresas e abordá-las aos poucos, com a IA conduzindo a conversa. | CRM › Prospecção (`/app/prospecting`) |
| `chamadas` | Histórico das ligações de voz feitas pela IA, com o texto do que foi dito. | CRM › Chamadas (`/app/calls`) |
| `comandas` | Registro do que foi feito para cada cliente, por quem, e quanto ele paga (serviços, como em salão ou clínica). | CRM › Comandas e Configurações › Comandas (`/app/comandas`) |
| `meta-ads` | Ver quanto custou cada resultado dos anúncios do Facebook e Instagram, e conectar a conta de anúncios. | Análise › Meta Ads (`/app/ads/meta`) e Configurações › Meta Ads (`/app/settings/meta-ads`) |
| `trunk-sip` | Dados de uma linha telefônica comum para a IA fazer ligações. | Configurações › Trunk SIP (`/app/settings/voip-trunk`) |
| `conversoes` | Avisar o Google e o Facebook quais anúncios geraram venda, e marcar de onde veio quem chegou pelo site. | Configurações › Conversões (`/app/settings/conversoes`) |
| `extensoes` | Guias extras instalados por cima do sistema para orientar o trabalho. | Configurações › Extensões (`/app/extensions`) e "Orientações instaladas" no hub do CRM |
| `contas-e-recebimentos` | Cadastro das contas onde o dinheiro das vendas do cliente entra. | Configurações › Contas e recebimentos (`/app/settings/tenant/financeiro`) |
| `provedores-ia` | Escolher qual "cérebro" de IA atende cada parte do sistema. A instalação já vem configurada. | IA › Provedores (`/app/ai/providers`) |
| `voz-whatsapp` | Ligação de voz pelo WhatsApp. Some o bloco em Segurança e a opção "Chamada de voz" em Conexões. | Configurações › Segurança (bloco "Chamada de voz pelo WhatsApp") e Conexões › Chamada de voz |
| `conexao-provedor-parceiro` | Conectar o WhatsApp por um serviço parceiro. | Conexões › Provedor parceiro |
| `conexao-telefone` | Conectar uma linha de telefone comum. | Conexões › Telefone |
| `conexao-redes-sociais` | Conectar Instagram e outras redes para atender por elas. | Conexões › Redes sociais |

## Notas

- Os modelos e as telas continuam existindo no código; só não têm porta. Os alertas da Central que apontavam para Provedores levam ao Início enquanto a função estiver oculta.
- Specs de teste de ponta a ponta das funções ocultas continuam no repositório, marcadas com o motivo e referência a este arquivo.
