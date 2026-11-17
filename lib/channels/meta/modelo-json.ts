/**
 * O MODELO DO WHATSAPP EM JSON — exportar e importar (painel de mensagens do
 * chat, 17/11/2026).
 *
 * O formato é o da Meta (`POST /{waba}/message_templates`): `name`, `language`,
 * `category` e `components` com os tipos em MAIÚSCULAS. É o mesmo corpo que o
 * formulário monta com `montarComponents`, então o JSON exportado volta ao
 * formulário sem perda, e o JSON copiado do Gerenciador da Meta entra direto.
 *
 * O que fica de FORA de propósito: cabeçalho de mídia e WhatsApp Flows. O
 * formulário do chat só tem cabeçalho de texto, e Flows ficou fora por decisão
 * do dono do produto. Recusar com o motivo é melhor que importar pela metade.
 *
 * Os limites vêm de `limites-do-modelo.ts` — a mesma régua da rota e da tela.
 * Módulo PURO: sem I/O. As mensagens de erro são frases de tela em português
 * (a chave do `t()`), com o caminho do campo culpado ao lado.
 */
import { z } from "zod";

import { LIMITES_DO_MODELO } from "@/lib/channels/limites-do-modelo";
import { IDIOMAS_DA_DEFINICAO, LIMITE_BOTOES } from "@/lib/channels/template-conteudo";

/** Categorias que a Meta aceita na criação. */
export const CATEGORIAS_DO_MODELO = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export type CategoriaDoModelo = (typeof CATEGORIAS_DO_MODELO)[number];

/** Teto da Meta por TIPO de botão, além do teto geral. */
const MAX_BOTOES_URL = 2;
const MAX_BOTOES_TELEFONE = 1;

const textoDoBotao = z
  .string({ message: "O botão precisa de texto." })
  .trim()
  .min(1, "O botão precisa de texto.")
  .max(LIMITES_DO_MODELO.textoDoBotao, "O texto do botão passa de 25 caracteres.");

const botaoSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("QUICK_REPLY"), text: textoDoBotao }),
    z.object({
      type: z.literal("URL"),
      text: textoDoBotao,
      url: z
        .string({ message: "O botão de link precisa de um endereço https://." })
        .trim()
        .max(LIMITES_DO_MODELO.urlDoBotao, "O endereço do botão é longo demais.")
        .regex(/^https:\/\/\S+$/, "O botão de link precisa de um endereço https://."),
      example: z.array(z.string()).optional(),
    }),
    z.object({
      type: z.literal("PHONE_NUMBER"),
      text: textoDoBotao,
      phone_number: z
        .string({ message: "O botão de telefone precisa de um número com código do país." })
        .trim()
        .regex(/^\+?\d{8,20}$/, "O botão de telefone precisa de um número com código do país."),
    }),
  ],
  { message: "Tipo de botão desconhecido. Use QUICK_REPLY, URL ou PHONE_NUMBER." },
);

const cabecalhoDeTextoSchema = z.object({
  type: z.literal("HEADER"),
  format: z.literal("TEXT", { message: "Só o cabeçalho de texto é aceito aqui (format: TEXT)." }),
  text: z
    .string({ message: "O cabeçalho precisa de texto." })
    .trim()
    .min(1, "O cabeçalho precisa de texto.")
    .max(LIMITES_DO_MODELO.cabecalhoTexto, "O cabeçalho passa de 60 caracteres."),
  example: z.object({ header_text: z.array(z.string()) }).optional(),
});

/**
 * Cabeçalho de mídia: o formulário das Conexões o monta (`montarComponents`,
 * `format: IMAGE` com `example.header_handle`). A importação de JSON do chat não
 * o aceita (ver o cabeçalho deste arquivo); a rota de criação aceita.
 */
const cabecalhoDeMidiaSchema = z.object({
  type: z.literal("HEADER"),
  format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"], {
    message: "Formato de cabeçalho desconhecido. Use TEXT, IMAGE, VIDEO ou DOCUMENT.",
  }),
  example: z.object({ header_handle: z.array(z.string().trim().min(1)).min(1) }).optional(),
});

const corpoSchema = z.object({
  type: z.literal("BODY"),
  text: z
    .string({ message: "O corpo precisa de texto." })
    .trim()
    .min(1, "O corpo precisa de texto.")
    .max(LIMITES_DO_MODELO.corpo, "O corpo passa de 1024 caracteres."),
  example: z
    .object({ body_text: z.array(z.array(z.string()), { message: "Os exemplos do corpo vão em body_text, uma lista dentro de outra." }) })
    .optional(),
});

const rodapeSchema = z.object({
  type: z.literal("FOOTER"),
  text: z
    .string({ message: "O rodapé precisa de texto." })
    .trim()
    .min(1, "O rodapé precisa de texto.")
    .max(LIMITES_DO_MODELO.rodape, "O rodapé passa de 60 caracteres."),
});

const botoesSchema = z.object({
  type: z.literal("BUTTONS"),
  buttons: z
    .array(botaoSchema)
    .min(1, "O bloco de botões está vazio.")
    .max(LIMITES_DO_MODELO.botoes, "A Meta aceita no máximo 10 botões."),
});

const MENSAGEM_TIPO_DESCONHECIDO = "Tipo de componente desconhecido. Use HEADER, BODY, FOOTER ou BUTTONS.";

/** O componente da IMPORTAÇÃO de JSON: só cabeçalho de texto. */
const componenteSchema = z.discriminatedUnion(
  "type",
  [cabecalhoDeTextoSchema, corpoSchema, rodapeSchema, botoesSchema],
  { message: MENSAGEM_TIPO_DESCONHECIDO },
);

/** O componente da ROTA de criação: o mesmo, mais o cabeçalho de mídia do formulário das Conexões. */
const componenteDaRotaSchema = z.discriminatedUnion(
  "type",
  [z.discriminatedUnion("format", [cabecalhoDeTextoSchema, cabecalhoDeMidiaSchema]), corpoSchema, rodapeSchema, botoesSchema],
  { message: MENSAGEM_TIPO_DESCONHECIDO },
);

type ComponenteLido = { type: string; buttons?: ReadonlyArray<{ type: string }> };

/** As regras da LISTA (um corpo, sem repetição, tetos por tipo de botão). Uma régua para a importação e para a rota. */
function conferirListaDeComponentes(
  components: readonly ComponenteLido[],
  ctx: z.RefinementCtx,
  caminho: (string | number)[],
): void {
  const conta = (tipo: string) => components.filter((c) => c.type === tipo).length;
  if (conta("BODY") !== 1) {
    ctx.addIssue({ code: "custom", path: caminho, message: "O modelo precisa de exatamente um corpo (BODY)." });
  }
  for (const tipo of ["HEADER", "FOOTER", "BUTTONS"]) {
    if (conta(tipo) > 1) {
      ctx.addIssue({ code: "custom", path: caminho, message: "Cada componente HEADER, FOOTER ou BUTTONS aparece uma vez só." });
    }
  }
  const botoes = components.flatMap((c) => (c.type === "BUTTONS" ? (c.buttons ?? []) : []));
  if (botoes.filter((b) => b.type === "URL").length > MAX_BOTOES_URL) {
    ctx.addIssue({ code: "custom", path: caminho, message: "A Meta aceita no máximo 2 botões de link." });
  }
  if (botoes.filter((b) => b.type === "PHONE_NUMBER").length > MAX_BOTOES_TELEFONE) {
    ctx.addIssue({ code: "custom", path: caminho, message: "A Meta aceita no máximo 1 botão de telefone." });
  }
}

/**
 * `components` como a rota `POST /api/v1/channels/templates` aceita (criar e
 * editar): a MESMA régua da importação de JSON, com o cabeçalho de mídia a mais.
 * A rota só VALIDA com isto e segue mandando o que recebeu: o `strip` do Zod não
 * pode tirar campo do corpo que vai para a Meta.
 */
export const componentesDoModeloSchema = z
  .array(componenteDaRotaSchema, { message: "Falta a lista components." })
  .min(1, "Falta a lista components.")
  .max(10, "A Meta aceita no máximo 10 componentes.")
  .superRefine((components, ctx) => conferirListaDeComponentes(components, ctx, []));

/** O modelo no formato da Meta, como o JSON é exportado e importado. */
export const modeloJsonSchema = z
  .object({
    name: z
      .string({ message: "Falta o nome do modelo." })
      .trim()
      .min(1, "Falta o nome do modelo.")
      .max(512, "O nome do modelo é longo demais.")
      .regex(/^[a-z0-9_]+$/, "O nome só aceita letras minúsculas, números e _."),
    language: z
      .string({ message: "Falta o idioma (ex.: pt_BR)." })
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Idioma inválido. Use o código da Meta, como pt_BR, es ou en_US."),
    category: z.enum(CATEGORIAS_DO_MODELO, {
      message: "Categoria inválida. Use MARKETING, UTILITY ou AUTHENTICATION.",
    }),
    components: z
      .array(componenteSchema, { message: "Falta a lista components." })
      .min(1, "Falta a lista components."),
  })
  .superRefine((modelo, ctx) => conferirListaDeComponentes(modelo.components, ctx, ["components"]));

export type ModeloJson = z.infer<typeof modeloJsonSchema>;

/** O que a importação devolve: o modelo pronto, ou o erro legível com o campo. */
export type ResultadoDaImportacao =
  | { ok: true; modelo: ModeloJson }
  | { ok: false; erro: string; campo: string | null };

/** `components.2.buttons.0.text` — o caminho que a pessoa procura no JSON colado. */
function caminho(path: readonly PropertyKey[]): string | null {
  return path.length ? path.map(String).join(".") : null;
}

/**
 * Lê o JSON colado. Nunca lança: texto que não é JSON, forma errada e limite
 * estourado voltam como `{ ok: false, erro, campo }` — a PRIMEIRA recusa, que é
 * a que a pessoa conserta antes das outras.
 *
 * `{{n}}` no corpo sem exemplo não é recusa aqui: o formulário pede o exemplo de
 * cada variável e a rota confere antes de falar com a Meta.
 */
export function importarModeloJson(texto: string): ResultadoDaImportacao {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return { ok: false, erro: "O texto colado não é um JSON válido.", campo: null };
  }
  const r = modeloJsonSchema.safeParse(bruto);
  if (!r.success) {
    const primeira = r.error.issues[0];
    return { ok: false, erro: primeira?.message ?? "JSON fora do formato da Meta.", campo: caminho(primeira?.path ?? []) };
  }
  const nBotoes = r.data.components.reduce((n, c) => n + (c.type === "BUTTONS" ? c.buttons.length : 0), 0);
  if (nBotoes > LIMITE_BOTOES) {
    return { ok: false, erro: "Este formulário edita até 3 botões.", campo: "components" };
  }
  if (!IDIOMAS_DA_DEFINICAO.some((i) => i.codigo === r.data.language)) {
    return { ok: false, erro: "Este idioma não está na lista do formulário.", campo: "language" };
  }
  return { ok: true, modelo: r.data };
}

/** O JSON exportado: o mesmo corpo que vai para a Meta, indentado para ler. */
export function exportarModeloJson(modelo: {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}): string {
  return JSON.stringify(
    { name: modelo.name, language: modelo.language, category: modelo.category, components: modelo.components },
    null,
    2,
  );
}
