/**
 * ENCAIXE DOS CAMPOS DA CAPTAÇÃO NOS CAMPOS DO FUNIL.
 *
 * O n8n (e qualquer formulário) manda `{"Empresa":"Hiperbold","Cargo":"Diretor",...}`: a chave é o
 * RÓTULO que a pessoa digitou no construtor do formulário. O funil declara o campo por `key`
 * (`empresa`, `cargo`, `utm_source`...) e a ficha do negócio lê SÓ pela `key` — então o dado chegava,
 * ficava gravado em `custom_fields` sob a chave crua e nunca aparecia em "Dados do lead" nem em
 * "Rastreamento".
 *
 * Esta função PURA (sem banco, sem env) descobre, para cada chave que chegou, o campo do funil a que ela
 * se refere, e devolve o `custom_fields` já com as chaves certas. A rota de captação a usa ao criar o lead;
 * o script `hiperbold/scripts/corrigir-campos-da-captacao.mts` usa a MESMA função nos leads que já
 * chegaram — uma segunda cópia da regra divergiria no primeiro caso de borda.
 *
 * Como uma chave casa com um campo (normalizado: minúsculas, sem acento, espaço/underscore/hífen
 * equivalentes), do mais forte ao mais fraco:
 *   1. a `key` do campo (igual, ou igual depois de normalizar);
 *   2. o `label` inteiro;
 *   3. o `label` antes do primeiro " / " ("Cargo" casa com "Cargo / Posição").
 * Se um mesmo nível casa com MAIS DE UM campo do funil, é ambíguo: a chave fica como veio. Errar o
 * destino de um dado é pior do que deixá-lo onde estava.
 *
 * Garantias:
 *   - nada se perde: chave sem campo correspondente fica como está;
 *   - nunca sobrescreve valor que já existe no campo de destino (só preenche campo vazio); a chave crua
 *     que não pôde ser encaixada por isso também fica;
 *   - valor vazio não é encaixado (não há dado a mover);
 *   - chave reservada (nome, e-mail, telefone, external_id, tags, cpf, data_nascimento) nunca é encaixada
 *     — tem destino próprio.
 */
import { inferirGrupoPelaChave } from "@/lib/leads/grupo-do-campo";

/** O mínimo que o encaixe precisa de um campo declarado em `crm_pipelines.settings.fields`. */
export interface CampoDoFunilParaEncaixe {
  key: string;
  label: string;
}

export interface EntradaDoEncaixe {
  /** O `custom_fields` do envio (ou do lead que já existe). Valores não-texto passam intactos. */
  campos: Record<string, unknown>;
  /**
   * A origem do envio (`source_metadata`): UTMs e ids de clique. Quando o funil declara o campo de
   * rastreamento e ele está vazio, o valor é COPIADO para `custom_fields` (a origem continua com ele).
   */
  rastreamento?: Record<string, unknown>;
  funil: readonly CampoDoFunilParaEncaixe[];
}

export interface ResultadoDoEncaixe {
  custom_fields: Record<string, unknown>;
  /** Quantas chaves cruas foram movidas para a `key` de um campo do funil. */
  movidos: number;
  /** Quantos valores de rastreamento foram copiados da origem para um campo do funil. */
  rastreamentoCopiado: number;
}

/** Chaves com destino próprio na captação: nunca viram campo personalizado, então nunca são encaixadas. */
const CHAVES_RESERVADAS = new Set([
  "nome",
  "name",
  "full_name",
  "fullname",
  "email",
  "e_mail",
  "mail",
  "telefone",
  "phone",
  "phone_number",
  "whatsapp",
  "celular",
  "tel",
  "external_id",
  "tags",
  "tags[]",
  "cpf",
  "cpf_cnpj",
  "data_nascimento",
]);

/**
 * Minúsculas, sem acento, e espaço/underscore/hífen contam como a mesma coisa. "Nível acadêmico",
 * "nivel_academico" e "NIVEL-ACADEMICO" saem iguais.
 */
export function normalizarChaveDeCampo(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** O rótulo antes do primeiro " / " ("Cargo / Posição" -> "Cargo"); `null` se não tem separador. */
function rotuloAntesDaBarra(label: string): string | null {
  const i = label.indexOf(" / ");
  if (i <= 0) return null;
  const antes = label.slice(0, i).trim();
  return antes === "" ? null : antes;
}

function vazio(valor: unknown): boolean {
  if (valor === null || valor === undefined) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

type Nivel = 1 | 2 | 3;
interface Alvo {
  key: string;
  nivel: Nivel;
}

/** Índices do funil: para cada nível, texto normalizado -> as `key`s que casam. */
function indexarFunil(funil: readonly CampoDoFunilParaEncaixe[]) {
  const chaves = new Map<string, Set<string>>();
  const rotulos = new Map<string, Set<string>>();
  const prefixos = new Map<string, Set<string>>();
  const chavesExatas = new Set<string>();
  const juntar = (mapa: Map<string, Set<string>>, texto: string, key: string): void => {
    const n = normalizarChaveDeCampo(texto);
    if (n === "") return;
    const conjunto = mapa.get(n) ?? new Set<string>();
    conjunto.add(key);
    mapa.set(n, conjunto);
  };
  for (const campo of funil) {
    chavesExatas.add(campo.key);
    juntar(chaves, campo.key, campo.key);
    juntar(rotulos, campo.label, campo.key);
    const antes = rotuloAntesDaBarra(campo.label);
    if (antes) juntar(prefixos, antes, campo.key);
  }
  return { chaves, rotulos, prefixos, chavesExatas };
}

/**
 * Descobre a `key` do campo do funil a que `chaveCrua` se refere; `null` quando não há campo, é
 * reservada ou é ambígua.
 */
function resolver(chaveCrua: string, indice: ReturnType<typeof indexarFunil>): Alvo | null {
  const n = normalizarChaveDeCampo(chaveCrua);
  if (n === "" || CHAVES_RESERVADAS.has(n) || CHAVES_RESERVADAS.has(chaveCrua.trim().toLowerCase())) return null;
  if (indice.chavesExatas.has(chaveCrua)) return { key: chaveCrua, nivel: 1 };
  const unico = (mapa: Map<string, Set<string>>): string | null => {
    const achados = mapa.get(n);
    return achados && achados.size === 1 ? [...achados][0]! : null;
  };
  const porChave = unico(indice.chaves);
  if (porChave) return { key: porChave, nivel: 1 };
  // Mais de um campo com a mesma chave normalizada: ambíguo, não adivinha pelo rótulo.
  if (indice.chaves.has(n)) return null;
  const porRotulo = unico(indice.rotulos);
  if (porRotulo) return { key: porRotulo, nivel: 2 };
  if (indice.rotulos.has(n)) return null;
  const porPrefixo = unico(indice.prefixos);
  if (porPrefixo) return { key: porPrefixo, nivel: 3 };
  return null;
}

export function encaixarCamposNoFunil(entrada: EntradaDoEncaixe): ResultadoDoEncaixe {
  const indice = indexarFunil(entrada.funil);
  const saida: Record<string, unknown> = {};
  let movidos = 0;
  let rastreamentoCopiado = 0;

  // Quem aponta para a PRÓPRIA key do campo já está no lugar certo: entra primeiro, e é por isso que
  // um valor que já existia no campo nunca perde para uma chave crua.
  const pendentes: Array<{ chave: string; valor: unknown; alvo: Alvo; ordem: number }> = [];
  let ordem = 0;
  for (const [chave, valor] of Object.entries(entrada.campos)) {
    ordem += 1;
    const alvo = vazio(valor) ? null : resolver(chave, indice);
    if (alvo === null || alvo.key === chave) {
      saida[chave] = valor;
    } else {
      pendentes.push({ chave, valor, alvo, ordem });
    }
  }

  // Do casamento mais forte ao mais fraco; empatando, na ordem em que chegaram (ordenação estável).
  pendentes.sort((a, b) => a.alvo.nivel - b.alvo.nivel || a.ordem - b.ordem);
  for (const p of pendentes) {
    if (vazio(saida[p.alvo.key])) {
      saida[p.alvo.key] = p.valor;
      movidos += 1;
    } else {
      // O campo de destino já tem valor: a chave crua fica, nada é sobrescrito nem perdido.
      saida[p.chave] = p.valor;
    }
  }

  for (const [chave, valor] of Object.entries(entrada.rastreamento ?? {})) {
    if (vazio(valor) || inferirGrupoPelaChave(chave) !== "rastreamento") continue;
    const alvo = resolver(chave, indice);
    if (alvo === null || !vazio(saida[alvo.key])) continue;
    saida[alvo.key] = valor;
    rastreamentoCopiado += 1;
  }

  return { custom_fields: saida, movidos, rastreamentoCopiado };
}
