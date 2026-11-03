import { CAMINHO_DO_CALLBACK_META_SOCIAL } from "./constantes";

export interface EnderecoParaAMeta {
  rotulo: string;
  url: string;
}

/**
 * Os endereços que o dono da instalação cadastra no painel da Meta para o
 * Instagram e o Messenger. Montados da origem pública da instalação e dos
 * caminhos fixos das rotas — os mesmos que o código usa.
 */
export function enderecosParaAMeta(base: string): EnderecoParaAMeta[] {
  return [
    { rotulo: "URL do webhook (Instagram e Messenger)", url: `${base}/api/v1/webhooks/meta-social` },
    { rotulo: "URL de retorno do login do Instagram", url: `${base}${CAMINHO_DO_CALLBACK_META_SOCIAL}/instagram` },
    { rotulo: "URL de retorno do login do Facebook (Messenger)", url: `${base}${CAMINHO_DO_CALLBACK_META_SOCIAL}/messenger` },
    { rotulo: "URL de exclusão de dados", url: `${base}/api/v1/meta/exclusao-de-dados` },
    // `/legal/privacy` é a página pública que existe (pública no proxy; segue a
    // política própria do operador quando ele cadastrou uma). `/privacidade`
    // não tem rota e responderia 404 à revisão da Meta.
    { rotulo: "URL da política de privacidade", url: `${base}/legal/privacy` },
  ];
}
