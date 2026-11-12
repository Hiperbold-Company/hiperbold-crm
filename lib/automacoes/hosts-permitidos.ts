/**
 * A chave do cofre PRESA AO ENDEREÇO (migration 1007, `automacao_segredos.hosts_permitidos`).
 *
 * Quem edita uma automação não vê o valor de nenhuma chave, mas escolhe para
 * onde o bloco "Requisição HTTP" a manda. Sem esta lista, um bloco apontado
 * para um servidor próprio, com a chave no cabeçalho, entregava o token a quem
 * montou o bloco. Agora cada chave diz para quais endereços (hosts) ela pode
 * ir, e o MOTOR confere na hora do envio, antes de qualquer requisição sair.
 *
 * Decisões (valem para a tela, a API, o publish e o motor — este arquivo é puro):
 *  - SÓ HOST EXATO, sem curinga. `*.exemplo.com` parece inofensivo, mas sem a
 *    lista de sufixos públicos não há como distinguir `*.empresa.com.br` de
 *    `*.com.br`, e um curinga em domínio compartilhado (`*.vercel.app`,
 *    `*.ngrok.io`, `*.herokuapp.com`) entrega a chave a qualquer um que crie um
 *    subdomínio lá. Quem precisa de dois subdomínios escreve os dois.
 *  - Sem esquema, caminho, porta, usuário ou curinga: só o nome do servidor.
 *    A porta não entra na comparação (o https e a guarda de destino já decidem).
 *  - Nome internacional vira punycode (`ação.com.br` → `xn--ao-xka2b.com.br`),
 *    o mesmo que a URL do bloco vira ao ser lida: comparar as duas formas
 *    ASCII é comparar o mesmo servidor.
 *  - `null` = chave antiga (anterior à 1007): continua indo para qualquer
 *    endereço, para não quebrar automação publicada; a tela avisa. Chave nova
 *    nasce com pelo menos um endereço (Zod da API e do formulário).
 *  - ABRIR a lista (pôr um endereço que ela não tinha) exige colar a chave de
 *    novo na mesma gravação (`ampliaOsHosts`). Gerente edita automação e
 *    também edita a chave: sem isto, o mesmo gerente que a lista quer conter
 *    acrescentava o próprio servidor e seguia. Fechar (tirar endereço) ou
 *    preencher a lista de uma chave antiga não pede o valor — só restringe.
 */
import { z } from "zod";

export const MAX_HOSTS_POR_CHAVE = 10;
export const MAX_TAMANHO_DO_HOST = 253;

/**
 * A forma guardada (igual ao CHECK da migration 1007): rótulos de letras
 * minúsculas, números e hífen (sem hífen nas pontas, até 63), pelo menos dois
 * rótulos — `localhost` e nome sem ponto não servem.
 */
export const FORMA_DO_HOST =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type ProblemaDoHost =
  "vazio" | "com_esquema" | "com_caminho" | "com_porta" | "com_usuario" | "curinga" | "invalido";

/** O endereço normalizado (minúsculas, punycode, sem ponto final) ou o motivo da recusa. */
export function lerHost(entrada: string): { host: string } | { problema: ProblemaDoHost } {
  const bruto = entrada.trim();
  if (bruto === "") return { problema: "vazio" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bruto) || bruto.includes("://"))
    return { problema: "com_esquema" };
  if (bruto.includes("*")) return { problema: "curinga" };
  if (bruto.includes("@")) return { problema: "com_usuario" };
  if (/[/?#\\]/.test(bruto)) return { problema: "com_caminho" };
  if (bruto.includes(":") || bruto.includes("[")) return { problema: "com_porta" };
  if (/[\s%]/.test(bruto)) return { problema: "invalido" };
  let host: string;
  try {
    // A URL faz o toASCII (punycode) e as minúsculas, igual ao que faz com a URL do bloco.
    const u = new URL(`https://${bruto}/`);
    if (u.port || u.username || u.password || u.pathname !== "/") return { problema: "invalido" };
    host = u.hostname;
  } catch {
    return { problema: "invalido" };
  }
  host = host.replace(/\.$/, "");
  if (host.length > MAX_TAMANHO_DO_HOST || !FORMA_DO_HOST.test(host))
    return { problema: "invalido" };
  return { host };
}

/** `lerHost` sem o motivo: o endereço normalizado ou `null`. */
export function normalizarHost(entrada: string): string | null {
  const r = lerHost(entrada);
  return "host" in r ? r.host : null;
}

/** O host que a URL (já lida pelo `URL`) vai chamar, na forma em que a lista guarda. */
export function hostDoDestino(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Pode a chave ir para este host? `permitidos` nulo = chave antiga, vai para
 * qualquer um. Lista presente: igualdade exata depois de normalizar os dois
 * lados. Lista vazia não existe (CHECK), mas se viesse, não deixaria nada passar.
 */
export function hostPermitido(hostname: string, permitidos: readonly string[] | null): boolean {
  if (permitidos === null) return true;
  const alvo = hostDoDestino(hostname);
  return permitidos.some((p) => (normalizarHost(p) ?? p) === alvo);
}

/** A lista recebida pela API ou pelo formulário: cada item normalizado, sem repetição, 1 a 10. */
export const hostsPermitidosSchema = z
  .array(z.string().max(300))
  .max(MAX_HOSTS_POR_CHAVE, `Até ${MAX_HOSTS_POR_CHAVE} endereços por chave`)
  .transform((lista, ctx) => {
    const saida: string[] = [];
    for (const item of lista) {
      const host = normalizarHost(item);
      if (host === null) {
        ctx.addIssue({ code: "custom", message: "endereço inválido" });
        return z.NEVER;
      }
      if (!saida.includes(host)) saida.push(host);
    }
    return saida;
  })
  .refine((l) => l.length >= 1, "Informe pelo menos um endereço");

/** Quebra o texto digitado pela pessoa (um por linha, vírgula ou espaço) em itens. */
export function separarHosts(texto: string): string[] {
  return texto
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Há algum endereço novo em relação à lista atual? `atual` nulo (chave antiga)
 * já vai para qualquer lugar: preencher a lista só fecha, nunca abre.
 */
export function ampliaOsHosts(atual: readonly string[] | null, nova: readonly string[]): boolean {
  if (atual === null) return false;
  return nova.some((h) => !atual.includes(h));
}

/** "A chave “token_meta” só pode ser enviada para api.servico.com.br." */
export function fraseDaChavePresa(nome: string, permitidos: readonly string[]): string {
  const lista =
    permitidos.length <= 1
      ? (permitidos[0] ?? "")
      : `${permitidos.slice(0, -1).join(", ")} ou ${permitidos[permitidos.length - 1]}`;
  return `A chave “${nome}” só pode ser enviada para ${lista}.`;
}

/**
 * O host fixo da URL do bloco (o domínio não aceita variável: `problemaDaUrl`
 * recusa), na forma da lista. `null` quando a URL ainda não tem forma.
 */
export function hostDaUrlDoBloco(url: string): string | null {
  try {
    const u = new URL(url.trim().replace(/\{\{[^}]*\}\}/g, "x"));
    if (!u.hostname) return null;
    return hostDoDestino(u.hostname);
  } catch {
    return null;
  }
}
