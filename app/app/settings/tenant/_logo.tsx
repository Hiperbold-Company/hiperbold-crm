"use client";

/**
 * Configurações › Organização › "Logo da empresa".
 *
 * Toda empresa pode enviar a própria logo, com ou sem o módulo
 * `marca_por_organizacao`: ela vira o avatar redondo da empresa no seletor de
 * organizações do menu. É o MESMO arquivo que a tela Marca grava como logo do
 * tema claro, pela mesma rota (`/api/v1/marca/logo`, escopo `organizacao`), com o
 * mesmo ajuste no navegador antes de subir (`ajustarLogo`). Com o módulo ligado,
 * a mesma logo também é a marca do produto no menu; o texto diz isso em vez de
 * prometer "só no seletor".
 *
 * Não reusa `CampoDeLogo` porque aquele desenha o logo do tema escuro (que exige
 * o módulo) e uma prévia sobre as duas aparências do sistema, que aqui não é a
 * pergunta: a pergunta é como o círculo do seletor vai ficar.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AvatarDaEmpresa } from "@/components/shell/AvatarDaEmpresa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { ajustarLogo } from "@/lib/branding/ajuste-de-logo";
import { lonaDoNavegador } from "@/lib/branding/lona-do-navegador";

interface Props {
  /** A URL pública da logo hoje gravada, ou `null`. */
  readonly logoUrl: string | null;
  /** Nome da empresa, para as iniciais do avatar sem logo. */
  readonly nome: string;
  /** O módulo `marca_por_organizacao` está ligado nesta instalação? Só muda o texto. */
  readonly marcaPropriaLigada: boolean;
}

const RAZAO_DO_TETO =
  "O logo precisa ter até 512 KB. Arquivo maior vai inteiro para o navegador em toda página.";

export function LogoDaEmpresaForm({ logoUrl, nome, marcaPropriaLigada }: Props) {
  const t = useT();
  const router = useRouter();
  const entrada = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState<string | null>(logoUrl);
  const [enviando, setEnviando] = useState(false);

  async function razaoDaFalha(resposta: Response): Promise<string> {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return t(corpo?.error?.message ?? "Não consegui trocar o logo agora.");
  }

  async function urlDaResposta(resposta: Response): Promise<string | null | undefined> {
    const corpo = (await resposta.json().catch(() => null)) as {
      data?: { logo_url?: string | null };
    } | null;
    return corpo?.data?.logo_url;
  }

  async function enviar(arquivoEscolhido: File) {
    setEnviando(true);
    try {
      const { arquivo, recusar } = await ajustarLogo(arquivoEscolhido, lonaDoNavegador);
      if (recusar) {
        toast.error(t(RAZAO_DO_TETO));
        return;
      }
      const corpo = new FormData();
      corpo.set("escopo", "organizacao");
      corpo.set("tema", "claro");
      corpo.set("file", arquivo);
      const resposta = await fetch("/api/v1/marca/logo", { method: "POST", body: corpo });
      if (!resposta.ok) {
        toast.error(await razaoDaFalha(resposta));
        return;
      }
      toast.success(t("Logo atualizado."));
      const gravada = await urlDaResposta(resposta);
      if (gravada !== undefined) setLogo(gravada);
      router.refresh();
    } finally {
      setEnviando(false);
      if (entrada.current) entrada.current.value = "";
    }
  }

  async function remover() {
    setEnviando(true);
    try {
      const resposta = await fetch("/api/v1/marca/logo?escopo=organizacao&tema=claro", {
        method: "DELETE",
      });
      if (!resposta.ok) {
        toast.error(await razaoDaFalha(resposta));
        return;
      }
      toast.success(t("Logo removido."));
      setLogo(null);
      router.refresh();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div id="logo-da-empresa" className="max-w-2xl scroll-mt-6" data-logo-da-empresa="">
      <Card className="space-y-3 p-6">
        <h2 className="text-sm font-medium">{t("Logo da empresa")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("A logo aparece num círculo ao lado do nome da empresa, no seletor de empresas do menu. Sem logo, o círculo mostra as iniciais.")}
          {marcaPropriaLigada
            ? ` ${t("Como a marca própria está ligada, ela também é a logo do sistema para esta empresa.")}`
            : ""}
        </p>
        <div className="flex items-center gap-4">
          <AvatarDaEmpresa nome={nome} logoUrl={logo} tamanho={48} />
          <AvatarDaEmpresa nome={nome} logoUrl={logo} tamanho={32} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="logo-da-empresa-arquivo">{t("Enviar logo")}</Label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={entrada}
              id="logo-da-empresa-arquivo"
              type="file"
              accept="image/png,image/jpeg"
              disabled={enviando}
              onChange={(e) => {
                const arquivo = e.target.files?.[0];
                if (arquivo) void enviar(arquivo);
              }}
              className="max-w-xs text-sm file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-border file:bg-surface-elevated file:px-3 file:py-1.5 file:text-sm"
            />
            {logo ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void remover()} disabled={enviando}>
                {t("Remover")}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("PNG ou JPG, até 512 KB. O círculo mostra o centro da imagem: prefira uma logo quadrada.")}
          </p>
        </div>
      </Card>
    </div>
  );
}
