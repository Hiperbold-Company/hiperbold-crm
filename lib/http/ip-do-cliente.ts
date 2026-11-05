/**
 * DE ONDE VEIO A REQUISIÇÃO, uma régua só.
 *
 * O repo lia isto inline em 15 lugares (`x-forwarded-for?.split(",")[0]`), e só
 * um deles (o rate limit de autenticação) tinha o plano B do `x-real-ip`, que
 * é o que o Nginx costuma setar sozinho. Quinze cópias de uma leitura é quinze
 * lugares para consertar quando a hospedagem muda de header.
 *
 * ═══ D-036: o PRIMEIRO salto era o que o CLIENTE escreve ═══
 *
 * `x-forwarded-for` é uma lista que cresce por APPEND: cada proxy pelo qual a
 * requisição passa acrescenta ao FIM o endereço de quem se conectou nele
 * diretamente. O primeiro item da lista é o que o cliente HTTP escolheu mandar,
 * e nada impede um `curl -H "X-Forwarded-For: 1.2.3.4"` de inventar qualquer
 * coisa ali. O item que um proxy NOSSO acrescentou é, por definição, verdadeiro:
 * é o endereço que ELE viu se conectando.
 *
 * Esta stack só tem os proxies que ELA MESMA sobe na frente do app (Caddy no
 * `docker-compose.prod.yml` padrão, ou o Traefik da hospedagem no override
 * `docker-compose.traefik.yml`: Coolify, Dokploy, CapRover, Hostinger). Em
 * QUALQUER uma dessas topologias medidas, é UM salto confiável entre o cliente
 * e o app: o último item da lista é sempre o que esse proxy acrescentou.
 *
 * `TRUSTED_PROXY_COUNT` existe para quem coloca infraestrutura ADICIONAL na
 * frente dessa (ex.: um CDN/WAF antes do Traefik da hospedagem); aí são dois
 * saltos confiáveis, e o valor bom passa a ser o PENÚLTIMO item, não o último.
 * Sem essa variável, o padrão (1) cobre a instalação normal sem quebrar nada.
 *
 * ═══ O QUE ESTE VALOR NÃO É ═══
 *
 * Não é prova de origem ABSOLUTA, é a leitura correta de um header que só um
 * proxy NOSSO escreve por último. Nada no produto pode DECIDIR acesso com base
 * nele, nem autorizar, nem bloquear. Ele serve para (a) isolar um balde de
 * rate limit, (b) registrar de onde uma ação veio no audit, para quem opera
 * reconhecer padrão e investigar.
 *
 * ═══ `null` em vez de sentinela ═══
 *
 * "Não sei de onde veio" precisa ser inexprimível como se fosse uma origem.
 * Uma string tipo `"desconhecido"` vira balde compartilhado no rate limit e
 * vira uma linha que parece um IP na tela. Índice insuficiente (menos saltos no
 * header do que `TRUSTED_PROXY_COUNT` configurado) também vira `null`: adivinhar
 * um índice errado devolveria um valor forjável, que é exatamente o defeito que
 * isto conserta.
 */

import { isIP } from "node:net";

import { ipEhEspecial } from "@/lib/automation/outbound-ip";

/**
 * Quantos proxies NOSSOS ficam entre o cliente e o app, cada um acrescentando
 * ao `x-forwarded-for`. Sem padrão declarado no repositório antes desta
 * mudança (ver D-036 em `hiperbold/DEBITO.md`). `0` desliga a confiança nos
 * dois headers (app exposto direto, sem proxy nenhum). Valor ausente, vazio ou
 * inválido cai no padrão de 1 (a topologia normal desta stack): a falha é
 * fechada, nunca aberta por uma variável mal escrita.
 */
function proxiesConfiaveis(): number | null {
  // Sem a variável (ou com valor inválido), vale o comportamento ANTIGO, o do
  // primeiro salto: a produção roda atrás de Cloudflare mais o Traefik da
  // hospedagem, e ligar a leitura de trás sem saber quantos saltos existem
  // poria todo mundo no balde de rate limit do mesmo endereço de borda. A
  // correção do D-036 liga quando a instalação declara a conta de saltos.
  const bruto = process.env.TRUSTED_PROXY_COUNT;
  if (bruto === undefined || bruto.trim() === "") return null;
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * O primeiro salto do `x-forwarded-for`, ou o `x-real-ip`. Sem proxy à frente o
 * Next já preenche o `x-forwarded-for` com o endereço do socket (ver
 * `chegouPelaBorda`), então `null` aqui é raro — não é sinal de "sem proxy".
 *
 * ═══ Quando a borda declara o cabeçalho (`IP_DO_CLIENTE_HEADER`) ═══
 *
 * O primeiro salto só é o cliente quando o proxy da frente SUBSTITUI o
 * `x-forwarded-for` recebido — é o que o Caddy do kit faz. A borda da
 * Cloudflare (`docker-compose.cloudflared.yml`) ACRESCENTA ao que o cliente
 * mandou, e o endereço real vai no `cf-connecting-ip`, que ela sobrescreve.
 * Por isso o override do túnel declara `IP_DO_CLIENTE_HEADER=cf-connecting-ip`
 * no app. Sem a variável, esse cabeçalho é ignorado: no modo Caddy quem o
 * escreveria é o próprio cliente. Valor ausente ou que não é IP cai na régua
 * de sempre.
 *
 * ═══ `TRUSTED_PROXY_COUNT` (Hiperbold, D-036) ═══
 *
 * Declarado, o cliente é o `TRUSTED_PROXY_COUNT`-ésimo salto a partir do FIM
 * do `x-forwarded-for` (`0` desliga a confiança nos headers); ausente, vale a
 * régua de sempre, a do primeiro salto. Índice curto demais vira `null`.
 */
export function ipDoCliente(headers: Headers): string | null {
  const declarado = process.env.IP_DO_CLIENTE_HEADER?.trim();
  if (declarado) {
    const daBorda = headers.get(declarado)?.trim();
    if (daBorda && isIP(daBorda) !== 0) return daBorda;
  }
  const confiaveis = proxiesConfiaveis();
  if (confiaveis === 0) return null;

  if (confiaveis === null) {
    const encaminhado = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (encaminhado) return encaminhado;
  } else {
    const encaminhados = headers.get("x-forwarded-for");
    if (encaminhados) {
      const saltos = encaminhados
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const indice = saltos.length - confiaveis;
      return indice >= 0 ? (saltos[indice] ?? null) : null;
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}

/**
 * O mesmo valor, mas só quando o Postgres o aceitaria como `inet`.
 *
 * A coluna `webhook_lead_captures.remote_ip` é `inet`, e um INSERT com texto que
 * não é IP falha com `22P02` — o que derrubaria o registro inteiro da captação
 * por causa de um header malformado (que é justamente o que um cliente hostil
 * mandaria). Aqui o valor inválido vira `null`: a linha entra, sem a origem.
 *
 * ═══ Por que `net.isIP` e não uma regex ═══
 *
 * A primeira versão desta função tinha uma regex escrita à mão para IPv6
 * (`/^[0-9a-fA-F:]+…/` mais `includes(":")`), e ela ACEITAVA lixo que o Postgres
 * recusa: `":::::"` passa (só hex e dois-pontos), `"12345::"` passa (cinco
 * dígitos hex num grupo de quatro). Qualquer um dos dois num `X-Forwarded-For`
 * derrubava o INSERT inteiro com `22P02` — e como `registrarCaptacao` não lança,
 * a captação sumia da tela em silêncio. Ou seja: um header hostil apagava do
 * histórico exatamente a batida que alguém queria investigar.
 *
 * `net.isIP` é a implementação do próprio Node (devolve 4, 6 ou 0) e não tem
 * como divergir por descuido de regex. IPv6 é notoriamente difícil de validar à
 * mão — `::ffff:1.2.3.4`, zeros comprimidos, grupos de tamanho variável — e
 * escrever essa regex era trabalho para uma ferramenta que já existe.
 *
 * ⚠️ `isIP` sozinho NÃO BASTA, e isto foi MEDIDO contra o Postgres, não
 * presumido — a primeira versão deste comentário afirmava o contrário:
 *
 *     node  -> isIP("fe80::1%eth0") === 6           (aceita a zona)
 *     psql  -> ERROR: invalid input syntax for type inet: "fe80::1%eth0"
 *
 * Ou seja, o identificador de zona (`%eth0`) atravessaria o guarda e recriaria
 * exatamente o `22P02` que ele existe para impedir. O `%` é recusado antes.
 * Notação CIDR (`/64`) também sai: o Postgres a aceitaria, mas um prefixo de
 * rede não é "de onde veio esta requisição".
 *
 * A validação é de FORMA, não de veracidade — ver o cabeçalho.
 */
export function ipDoClienteParaInet(headers: Headers): string | null {
  const bruto = ipDoCliente(headers);
  if (bruto === null) return null;
  if (bruto.includes("%") || bruto.includes("/")) return null;
  return isIP(bruto) === 0 ? null : bruto;
}

/**
 * Cabeçalhos que só um proxy escreve. O servidor do Next NÃO os inventa — ao
 * contrário do `x-forwarded-for`, ver abaixo.
 *
 *   x-real-ip          — Traefik (sempre) e Nginx Proxy Manager (`proxy.conf`)
 *   x-forwarded-server — Traefik (sempre)
 *   cf-connecting-ip   — túnel/borda da Cloudflare
 *   forwarded          — RFC 7239, quem segue o padrão novo
 */
const MARCAS_DE_PROXY = ["x-real-ip", "x-forwarded-server", "cf-connecting-ip", "forwarded"] as const;

/**
 * A requisição atravessou um proxy de borda (veio da internet)?
 *
 * ═══ Por que não basta "tem `x-forwarded-for`" ═══
 *
 * O próprio Next preenche `x-forwarded-for` (com o endereço do socket),
 * `x-forwarded-host`, `-port` e `-proto` quando eles chegam ausentes
 * (`next/dist/server/base-server.js`, `??=`). Medido numa instalação real: a
 * chamada que vem da rede interna do Docker chega à rota com
 * `x-forwarded-for: 10.0.4.x`. A presença do cabeçalho não distingue nada; o
 * VALOR distingue — o Next põe o endereço privado do vizinho de rede, e todo
 * proxy de borda põe o do cliente, que é público.
 *
 * Interna = nenhuma marca de proxy, `x-forwarded-proto` diferente de `https`
 * (a rede interna fala HTTP puro; quem termina TLS é a borda) E todo salto do
 * `x-forwarded-for` (se houver) é endereço de faixa especial (privada,
 * loopback, link-local…).
 *
 * ═══ Por que isto pode decidir, ao contrário de `ipDoCliente` ═══
 *
 * Só decide RECUSAR, e se apoia no que os proxies do kit escrevem: o Caddy
 * substitui o `x-forwarded-for` recebido pelo endereço real e marca
 * `x-forwarded-proto: https`; o Traefik sempre escreve `x-real-ip` e
 * `x-forwarded-server`; o Nginx Proxy Manager escreve `x-real-ip`; o túnel da
 * Cloudflare escreve `cf-connecting-ip`. O `https` cobre também o caso em que
 * o Docker entrega ao proxy um endereço privado no lugar do cliente.
 *
 * ponytail: régua de cabeçalho, válida nos proxies do kit. A camada seguinte
 * é a assinatura do remetente (exigível em /admin/sistema).
 */
export function chegouPelaBorda(headers: Headers): boolean {
  if (MARCAS_DE_PROXY.some((nome) => headers.has(nome))) return true;
  if (headers.get("x-forwarded-proto")?.trim().toLowerCase() === "https") return true;
  const saltos = headers.get("x-forwarded-for");
  if (saltos === null) return false;
  return saltos.split(",").some((salto) => {
    const ip = salto.trim();
    return isIP(ip) === 0 || !ipEhEspecial(ip);
  });
}
