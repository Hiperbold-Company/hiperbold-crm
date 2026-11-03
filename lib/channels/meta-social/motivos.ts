/**
 * Os motivos de volta do OAuth do canal social oficial — UM conjunto, lido
 * pelo backend (que redireciona com `motivo=<código>`) e pela tela (que mostra
 * a frase). Puro e sem dependência de servidor: a tela importa este arquivo.
 *
 * Antes eram duas listas: a tela conhecia `cancelado`, `estado_invalido`,
 * `sem_paginas`, `falha_meta`, e o backend emitia `conexao_cancelada`,
 * `retorno_nao_verificavel`, `nenhuma_pagina`, `meta_recusou`. Nenhum código
 * casava, e toda volta com erro caía na frase genérica. Agora o tipo
 * `MotivoDaVolta` é o que as rotas aceitam, e um código sem frase não compila.
 *
 * A frase é para quem NÃO programa: diz o que aconteceu e o que fazer.
 */
export const FRASES_DOS_MOTIVOS = {
  nao_configurado: "A conexão ainda não foi liberada nesta instalação.",
  limite_do_plano: "Seu plano chegou ao limite de conexões.",
  mfa_required:
    "Para conectar, confirme antes o código da verificação em duas etapas da sua conta. Depois clique em Conectar de novo.",
  plataforma_invalida:
    "Este link de conexão está incompleto. Volte para Conexões e clique em Conectar de novo.",
  retorno_nao_verificavel:
    "A conexão expirou ou foi aberta em outra janela. Clique em Conectar para tentar de novo.",
  retorno_incompleto:
    "A Meta não devolveu a autorização. Clique em Conectar e conclua todas as etapas na janela da Meta.",
  conexao_cancelada:
    "A conexão foi cancelada antes de terminar. Clique em Conectar para tentar de novo.",
  sem_permissao:
    "Só quem administra a empresa no sistema pode conectar contas. Peça a um administrador para conectar.",
  conta_em_outra_organizacao:
    "Esta conta já está conectada em outra empresa neste sistema. Desconecte lá antes de conectar aqui.",
  nenhuma_pagina:
    "Não encontramos nenhuma conta para conectar. Confira se você é administrador da Página e se marcou a conta na hora de autorizar.",
  nenhuma_conta_instagram:
    "Não encontramos nenhuma conta do Instagram para conectar. Confira se a conta é profissional, se está num portfólio de negócios da Meta e se você marcou a conta na hora de autorizar.",
  meta_recusou:
    "A Meta recusou a conexão. Tente de novo em alguns minutos. Se continuar, confira se a conta é profissional e se você aceitou todas as permissões.",
  cifra_indisponivel:
    "O sistema não conseguiu guardar o acesso da conta com segurança, então nada foi conectado. Avise quem cuida do servidor.",
  gravacao_falhou: "Não conseguimos salvar a conexão. Tente de novo em alguns minutos.",
  falha_inesperada: "Algo deu errado ao conectar. Tente de novo em alguns minutos.",
  segredo_indisponivel:
    "A conexão não pôde começar porque falta uma configuração no servidor. Avise quem cuida da instalação.",
} as const satisfies Record<string, string>;

export type MotivoDaVolta = keyof typeof FRASES_DOS_MOTIVOS;

export const MOTIVOS_DA_VOLTA = Object.keys(FRASES_DOS_MOTIVOS) as MotivoDaVolta[];

export function ehMotivoDaVolta(v: unknown): v is MotivoDaVolta {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FRASES_DOS_MOTIVOS, v);
}

/** A frase do motivo; código desconhecido (link antigo, URL editada) cai na genérica. */
export function fraseDoMotivo(codigo: string | null | undefined): string {
  return ehMotivoDaVolta(codigo) ? FRASES_DOS_MOTIVOS[codigo] : FRASES_DOS_MOTIVOS.falha_inesperada;
}
