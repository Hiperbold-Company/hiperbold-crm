/**
 * Os primeiros passos do cliente no CRM: o que já está feito e o que falta, na tela Início
 * (`/app/inicio`). Função PURA: recebe o que o servidor já leu e devolve a lista pronta para
 * desenhar. Quem lê o banco é `./carregar.ts`; aqui não há I/O, de modo que "todas as combinações
 * de feito e pendente" se provam em teste sem banco.
 *
 * ─── Obrigatório e opcional ─────────────────────────────────────────────────
 *
 * Obrigatório é o que faz o CRM servir ao cliente no dia seguinte: plano, e-mail confirmado, perfil
 * da empresa e o WhatsApp conectado. É por eles que a entrada em `/app` decide abrir o Início ou o
 * Inbox (`./entrada.ts`). Opcional é o que melhora o uso e nunca segura ninguém na tela.
 *
 * ─── Itens que nem aparecem ─────────────────────────────────────────────────
 *
 * Plano e e-mail só existem como passo quando a compra pelo cliente está ligada (`compraLigada`): numa
 * instalação própria não há o que pagar nem o fluxo de confirmação que este fork acrescenta, e um
 * passo que o cliente não tem como cumprir é pior do que passo nenhum. O logo some quando o módulo
 * `marca_por_organizacao` está desligado (a tela de Marca nem existe).
 *
 * ─── Perfil da empresa ──────────────────────────────────────────────────────
 *
 * Feito quando "o que a empresa faz" está preenchido E há fuso. Não existe horário de atendimento da
 * EMPRESA no produto (só o `schedule` de cada atendente, em `attendant_availability`), então o horário
 * não entra na régua: inventar a coluna só para ter o que perguntar seria contrato sem consumidor.
 */

export type TipoDoPasso = "obrigatorio" | "opcional";

export type IdDoPasso = "plano" | "email" | "perfil" | "whatsapp" | "agente" | "logo" | "followup" | "equipe";

export interface PassoDoInicio {
  id: IdDoPasso;
  titulo: string;
  descricao: string;
  tipo: TipoDoPasso;
  feito: boolean;
  href: string;
  /** Texto do botão. Já feito, vira o convite a rever ("Ver"), nunca some. */
  cta: string;
}

/** O que o servidor já leu. Tudo o que é "existe ou não" chega como booleano. */
export interface DadosDosPrimeirosPassos {
  /** A compra pelo cliente está ligada nesta instalação? Sem ela, não há passos de plano nem de e-mail. */
  compraLigada: boolean;
  /** Contrato `ativa` ou em `avaliacao`. */
  planoAtivo: boolean;
  emailVerificado: boolean;
  /** `onboarding_state.welcome.o_que_faz`. */
  oQueFaz: string | null;
  /** `organizations.timezone`. */
  fuso: string | null;
  /** Ao menos um canal de mensagem em `WORKING`. */
  whatsappConectado: boolean;
  /** Algum `ai_agents` com `published_version_id` e não arquivado. */
  agentePublicado: boolean;
  /** O módulo `marca_por_organizacao` está ligado (sem ele a tela de Marca não existe)? */
  marcaPorOrganizacaoLigada: boolean;
  /** `organizations.settings.branding.logo_path` preenchido. */
  logoDefinido: boolean;
  /** Algum `followup_flow_pointers.active_version_id` não nulo. */
  followupAtivo: boolean;
  /** Vínculos ativos (não revogados) na organização. */
  membrosAtivos: number;
}

export interface ContagemDosPassos {
  obrigatoriosTotal: number;
  obrigatoriosFeitos: number;
  opcionaisTotal: number;
  opcionaisFeitos: number;
  /** Quantos obrigatórios faltam. Zero = o essencial está pronto. */
  obrigatoriosFaltando: number;
}

export interface PrimeirosPassos {
  /** Obrigatórios primeiro, depois opcionais; dentro de cada bloco, a ordem em que se faz. */
  passos: PassoDoInicio[];
  contagem: ContagemDosPassos;
}

function preenchido(valor: string | null | undefined): boolean {
  return typeof valor === "string" && valor.trim().length > 0;
}

export function primeirosPassos(dados: DadosDosPrimeirosPassos): PrimeirosPassos {
  const obrigatorios: PassoDoInicio[] = [];
  const opcionais: PassoDoInicio[] = [];

  if (dados.compraLigada) {
    obrigatorios.push({
      id: "plano",
      titulo: "Plano ativo",
      descricao: "Seu plano está pago e liberado para usar.",
      tipo: "obrigatorio",
      feito: dados.planoAtivo,
      href: "/app/settings/plano",
      cta: dados.planoAtivo ? "Ver meu plano" : "Escolher plano",
    });
    obrigatorios.push({
      id: "email",
      titulo: "Confirmar seu e-mail",
      descricao: "Confirmando, você recebe os avisos importantes e pode recuperar o acesso quando precisar.",
      tipo: "obrigatorio",
      feito: dados.emailVerificado,
      href: "/app/settings/profile",
      cta: dados.emailVerificado ? "Ver meu perfil" : "Reenviar",
    });
  }

  const perfilFeito = preenchido(dados.oQueFaz) && preenchido(dados.fuso);
  obrigatorios.push({
    id: "perfil",
    titulo: "Perfil da empresa",
    descricao: "Conte o que sua empresa faz e confirme o fuso horário. O atendente de IA usa isso para falar do seu negócio.",
    tipo: "obrigatorio",
    feito: perfilFeito,
    href: "/app/settings/tenant#perfil-da-empresa",
    cta: perfilFeito ? "Editar" : "Preencher",
  });

  obrigatorios.push({
    id: "whatsapp",
    titulo: "Conectar o WhatsApp",
    descricao: "Leia o QR Code com o celular da empresa para receber e responder mensagens aqui.",
    tipo: "obrigatorio",
    feito: dados.whatsappConectado,
    href: "/app/connections",
    cta: dados.whatsappConectado ? "Ver conexões" : "Conectar",
  });

  opcionais.push({
    id: "agente",
    titulo: "Criar e publicar o agente de IA",
    descricao: "O agente atende seus clientes no WhatsApp e passa para a equipe quando precisa.",
    tipo: "opcional",
    feito: dados.agentePublicado,
    href: "/app/ai/agents",
    cta: dados.agentePublicado ? "Ver agentes" : "Criar agente",
  });

  if (dados.marcaPorOrganizacaoLigada) {
    opcionais.push({
      id: "logo",
      titulo: "Logo da empresa",
      descricao: "Coloque sua logo para o CRM ficar com a cara do seu negócio.",
      tipo: "opcional",
      feito: dados.logoDefinido,
      href: "/app/settings/marca",
      cta: dados.logoDefinido ? "Trocar logo" : "Enviar logo",
    });
  }

  opcionais.push({
    id: "followup",
    titulo: "Follow-up automático",
    descricao: "Retome a conversa com quem parou de responder, sem precisar lembrar de cada pessoa.",
    tipo: "opcional",
    feito: dados.followupAtivo,
    href: "/app/ai/followups",
    cta: dados.followupAtivo ? "Ver follow-ups" : "Criar follow-up",
  });

  const equipeFeita = dados.membrosAtivos > 1;
  opcionais.push({
    id: "equipe",
    titulo: "Convidar a equipe",
    descricao: "Chame quem atende com você para dividir as conversas.",
    tipo: "opcional",
    feito: equipeFeita,
    href: "/app/team",
    cta: equipeFeita ? "Ver equipe" : "Convidar",
  });

  const obrigatoriosFeitos = obrigatorios.filter((p) => p.feito).length;
  return {
    passos: [...obrigatorios, ...opcionais],
    contagem: {
      obrigatoriosTotal: obrigatorios.length,
      obrigatoriosFeitos,
      opcionaisTotal: opcionais.length,
      opcionaisFeitos: opcionais.filter((p) => p.feito).length,
      obrigatoriosFaltando: obrigatorios.length - obrigatoriosFeitos,
    },
  };
}
