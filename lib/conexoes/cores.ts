/**
 * A COR DA ETIQUETA DA CONEXÃO — a paleta única (migration 1012, fork Hiperbold).
 *
 * Cada conexão (número de WhatsApp, número oficial, conta de rede social) pode
 * ganhar uma cor. Ela pinta a etiqueta pequena que diz, em cada linha da lista
 * do Chat, por qual número a conversa entrou, e aparece como prévia no cartão
 * da conexão em Configurações › Conexões. Pedido do dono do produto
 * (12/11/2026), depois de um cliente conectar dois números e não distinguir as
 * conversas de cada um.
 *
 * ─── Por que CHAVE, e não hex ───────────────────────────────────────────────
 *
 * O banco guarda a chave (`channel_sessions.label_color`, CHECK com as doze
 * chaves abaixo) e os tons moram só aqui. Assim os tons podem ser afinados sem
 * migration, e cor livre (a única forma de uma etiqueta virar ilegível por
 * decisão humana) não existe. O CHECK do banco e esta tupla são vigiados juntos
 * por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 *
 * ─── Dois temas ─────────────────────────────────────────────────────────────
 *
 * Tom pastel claro com texto escuro do mesmo matiz no tema claro; fundo escuro
 * do mesmo matiz com texto pastel no escuro. Cada par passa de 4,5:1 (WCAG
 * 1.4.3), medido por `razaoDeContraste` em `lib/conexoes/cores.test.ts`.
 *
 * Sem cor escolhida (`null`), a etiqueta continua exatamente como era.
 */

/** As doze chaves, na ordem da fileira do seletor. Fonte do CHECK do banco. */
export const CHAVES_DE_COR_DA_CONEXAO = [
  "rosa",
  "coral",
  "pessego",
  "amarelo",
  "lima",
  "verde",
  "menta",
  "turquesa",
  "azul",
  "lavanda",
  "lilas",
  "cinza",
] as const;

export type CorDaConexao = (typeof CHAVES_DE_COR_DA_CONEXAO)[number];

export interface TomDaEtiqueta {
  fundo: string;
  texto: string;
}

export interface DefinicaoDaCor {
  /** Nome que a tela mostra (passa por `t()`). */
  nome: string;
  claro: TomDaEtiqueta;
  escuro: TomDaEtiqueta;
}

export const PALETA_DA_CONEXAO: Readonly<Record<CorDaConexao, DefinicaoDaCor>> = {
  rosa: {
    nome: "Rosa",
    claro: { fundo: "#fce7f3", texto: "#9d174d" },
    escuro: { fundo: "#500724", texto: "#fbcfe8" },
  },
  coral: {
    nome: "Coral",
    claro: { fundo: "#fee2e2", texto: "#991b1b" },
    escuro: { fundo: "#450a0a", texto: "#fecaca" },
  },
  pessego: {
    nome: "Pêssego",
    claro: { fundo: "#ffedd5", texto: "#9a3412" },
    escuro: { fundo: "#431407", texto: "#fed7aa" },
  },
  amarelo: {
    nome: "Amarelo",
    claro: { fundo: "#fef9c3", texto: "#854d0e" },
    escuro: { fundo: "#422006", texto: "#fef08a" },
  },
  lima: {
    nome: "Lima",
    claro: { fundo: "#ecfccb", texto: "#3f6212" },
    escuro: { fundo: "#1a2e05", texto: "#d9f99d" },
  },
  verde: {
    nome: "Verde",
    claro: { fundo: "#dcfce7", texto: "#166534" },
    escuro: { fundo: "#052e16", texto: "#bbf7d0" },
  },
  menta: {
    nome: "Menta",
    claro: { fundo: "#d1fae5", texto: "#065f46" },
    escuro: { fundo: "#022c22", texto: "#a7f3d0" },
  },
  turquesa: {
    nome: "Turquesa",
    claro: { fundo: "#cffafe", texto: "#155e75" },
    escuro: { fundo: "#083344", texto: "#a5f3fc" },
  },
  azul: {
    nome: "Azul",
    claro: { fundo: "#dbeafe", texto: "#1e40af" },
    escuro: { fundo: "#172554", texto: "#bfdbfe" },
  },
  lavanda: {
    nome: "Lavanda",
    claro: { fundo: "#e0e7ff", texto: "#3730a3" },
    escuro: { fundo: "#1e1b4b", texto: "#c7d2fe" },
  },
  lilas: {
    nome: "Lilás",
    claro: { fundo: "#f3e8ff", texto: "#6b21a8" },
    escuro: { fundo: "#3b0764", texto: "#e9d5ff" },
  },
  cinza: {
    nome: "Cinza",
    claro: { fundo: "#f1f5f9", texto: "#334155" },
    escuro: { fundo: "#1e293b", texto: "#e2e8f0" },
  },
};

/** `true` só para uma das doze chaves. */
export function ehCorDaConexao(valor: unknown): valor is CorDaConexao {
  return (
    typeof valor === "string" && (CHAVES_DE_COR_DA_CONEXAO as readonly string[]).includes(valor)
  );
}

/**
 * Leitura tolerante: o que vier do banco ou da API e não for uma chave conhecida
 * vira "sem cor" (aparência de antes), nunca erro de tela.
 */
export function lerCorDaConexao(valor: unknown): CorDaConexao | null {
  return ehCorDaConexao(valor) ? valor : null;
}

/**
 * As variáveis CSS que a etiqueta e a prévia usam. O tema decide qual par vale
 * pela classe (`ESTILO_DA_ETIQUETA_COLORIDA`), então o mesmo `style` serve aos
 * dois temas sem o componente saber em qual está. `null` = sem variáveis.
 */
export function variaveisDaCor(cor: CorDaConexao | null): Record<string, string> | null {
  if (!cor) return null;
  const d = PALETA_DA_CONEXAO[cor];
  return {
    "--etq-conexao-fundo": d.claro.fundo,
    "--etq-conexao-texto": d.claro.texto,
    "--etq-conexao-fundo-escuro": d.escuro.fundo,
    "--etq-conexao-texto-escuro": d.escuro.texto,
  };
}

/** As classes que leem as variáveis acima, nos dois temas. */
export const ESTILO_DA_ETIQUETA_COLORIDA =
  "border-transparent bg-[color:var(--etq-conexao-fundo)] text-[color:var(--etq-conexao-texto)] dark:bg-[color:var(--etq-conexao-fundo-escuro)] dark:text-[color:var(--etq-conexao-texto-escuro)]";
