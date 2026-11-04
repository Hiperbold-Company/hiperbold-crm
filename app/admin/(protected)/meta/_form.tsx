"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  rotacionarVerifyTokenDaMeta,
  updateAppSocialDaMeta,
  updateMetaApp,
  type UpdateMetaAppResult,
} from "@/app/actions/settings/updateMetaApp";
import type { EnderecoParaAMeta } from "@/lib/channels/meta-social/enderecos";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  /**
   * SE existe chave gravada — nunca QUAL, nem cifrada. Mesma disciplina de
   * `temSegredoSalvo` em `/admin/google` e de `hasToken` no canal oficial.
   */
  readonly temSegredoSalvo: boolean;
  /** SE existe token gravado. O valor não tem leitura: sai só da action que o gera. */
  readonly temTokenSalvo: boolean;
  readonly tokenGeradoEm: string | null;
  readonly atualizadoEm: string | null;
  /** O par está no `.env` desta instalação (o piso de rollback). */
  readonly temNoAmbiente: boolean;
  readonly leituraFalhou: boolean;
  /**
   * Instagram Direct e Messenger pela conexão oficial (migrations 0984 e
   * 0988). O id do app e o `config_id` do login unificado não são segredo e
   * voltam preenchidos.
   */
  readonly social?: {
    readonly appId: string | null;
    readonly configIdDoLoginUnificado: string | null;
    readonly enderecos: readonly EnderecoParaAMeta[];
  };
}

/** O piso do schema da action. Abaixo disso o Zod recusa e a tela culparia o dono. */
const TAMANHO_MINIMO_DA_CHAVE = 16;

export function FormularioDaMeta({
  temSegredoSalvo,
  temTokenSalvo,
  tokenGeradoEm,
  atualizadoEm,
  temNoAmbiente,
  leituraFalhou,
  social,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [chave, setChave] = useState("");
  /**
   * O token recém-gerado vive SÓ aqui, na memória desta aba. Recarregar a página
   * o perde — e isso é o desenho, não um defeito: a tela diz para copiar agora e
   * oferece gerar outro.
   */
  const [tokenNovo, setTokenNovo] = useState<string | null>(null);
  const [confirmandoTroca, setConfirmandoTroca] = useState(false);
  const [ocupado, iniciar] = useTransition();

  const podeSalvar = chave.trim().length >= TAMANHO_MINIMO_DA_CHAVE;

  const [appId, setAppId] = useState(social?.appId ?? "");
  const [configId, setConfigId] = useState(social?.configIdDoLoginUnificado ?? "");
  const idValido = (v: string) => v.trim() === "" || /^[0-9]{5,30}$/.test(v.trim());
  const socialMudou =
    appId.trim() !== (social?.appId ?? "") || configId.trim() !== (social?.configIdDoLoginUnificado ?? "");
  const podeSalvarSocial = socialMudou && idValido(appId) && idValido(configId);

  function motivoDaRecusa(r: Extract<UpdateMetaAppResult, { ok: false }>): string {
    if (ehRecusaDeEscrita(r.error)) return t(MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]);
    switch (r.error) {
      case "invalid_input":
        return t("A chave parece incompleta. Copie de novo do painel da Meta — ela tem 32 caracteres.");
      case "app_secret_obrigatorio":
        return t("Cadastre a chave secreta do aplicativo primeiro. Sem ela o token não vale.");
      case "nada_para_salvar":
        return t("Nada mudou. Digite uma chave nova para substituir a atual.");
      case "leitura_do_app_falhou":
        return t("Não consegui conferir o que já está gravado, então nada foi alterado. Tente de novo em instantes.");
      default:
        // Cifra indisponível ou erro do banco: o texto da action diz qual, e
        // quem administra o servidor precisa dele para agir. Nada foi gravado.
        return `${t("Não deu para salvar, e nada foi gravado.")} ${t(r.error)}`;
    }
  }

  function aoGravar(r: UpdateMetaAppResult, sucesso: string) {
    if (!r.ok) {
      toast.error(motivoDaRecusa(r));
      return;
    }
    if (r.verifyToken) setTokenNovo(r.verifyToken);
    toast.success(sucesso);
    router.refresh();
  }

  function salvar() {
    iniciar(async () => {
      const r = await updateMetaApp({ app_secret: chave.trim() });
      if (r.ok) setChave("");
      aoGravar(r, t("Chave secreta salva."));
    });
  }

  function salvarSocial() {
    iniciar(async () => {
      // Só o que mudou: id igual ao gravado não vai, e a chave vazia é "manter".
      const r = await updateAppSocialDaMeta({
        app_id: appId.trim() !== (social?.appId ?? "") ? appId.trim() : undefined,
        unified_config_id:
          configId.trim() !== (social?.configIdDoLoginUnificado ?? "") ? configId.trim() : undefined,
      });
      aoGravar(r, t("Configuração do Instagram e do Messenger salva."));
    });
  }

  function gerarToken() {
    setConfirmandoTroca(false);
    iniciar(async () => {
      aoGravar(await rotacionarVerifyTokenDaMeta(), t("Token de verificação gerado."));
    });
  }

  async function copiar(valor: string) {
    if (await copyToClipboard(valor)) toast.success(t("Copiado."));
    else toast.error(t("Não deu para copiar. Selecione o texto e copie à mão."));
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("API Oficial da Meta desta instalação")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("É com estas duas informações que o sistema confere que cada mensagem recebida pelo número oficial veio mesmo da Meta. Elas valem para a instalação inteira — cada empresa conecta o próprio número depois, em Conexões.")}
        </p>
      </header>

      {leituraFalhou ? (
        <p
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted"
        >
          {t("Não deu para ler a configuração salva agora, então o que aparece abaixo pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-app-secret">{t("Chave secreta do aplicativo")}</Label>
          <Input
            id="meta-app-secret"
            data-testid="meta-app-secret"
            type="password"
            autoComplete="off"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={temSegredoSalvo ? t("••••••••  (já cadastrada)") : t("32 letras e números")}
          />
          <p className="text-xs text-muted-foreground">
            {temSegredoSalvo
              ? t("Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("Fica no painel da Meta, em Configurações do app › Básico. Ela é guardada cifrada e nunca volta a aparecer nesta tela.")}
          </p>
        </div>

        {temNoAmbiente ? (
          <p
            data-testid="meta-tem-no-ambiente"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t("Esta instalação já tem a chave e o token no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar deles — e, a partir daí, é o token desta tela que precisa estar colado no painel da Meta.")}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {atualizadoEm
              ? `${t("Última alteração em")} ${atualizadoEm}.`
              : t("Nunca configurado por aqui.")}
          </span>
          <Button data-testid="meta-salvar" disabled={!podeSalvar || ocupado} onClick={salvar}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{t("Token de verificação")}</h2>
          <p className="text-sm text-muted-foreground" data-testid="meta-token-estado">
            {temTokenSalvo && tokenGeradoEm
              ? `${t("Gerado em")} ${tokenGeradoEm}.`
              : temTokenSalvo
                ? t("Já existe um token gerado.")
                : t("Ainda não existe. Ele é criado pelo sistema na primeira vez que você salva a chave secreta — ninguém precisa inventar nada.")}
          </p>
        </div>

        {tokenNovo ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-token-gerado">{t("Seu token de verificação")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="meta-token-gerado"
                data-testid="meta-token-gerado"
                readOnly
                value={tokenNovo}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                data-testid="meta-copiar-token"
                onClick={() => void copiar(tokenNovo)}
              >
                {t("Copiar")}
              </Button>
            </div>
            <p className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
              <strong className="font-semibold text-text">{t("Copie agora.")}</strong>{" "}
              {t("Por segurança, ele não aparece de novo depois que você sair desta página. Se perder, é só gerar outro aqui.")}
            </p>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {t("No painel da Meta, em WhatsApp › Configuração › Webhook, este token vai no campo “Verificar token”. O outro campo, “URL de callback”, é de cada número: ele aparece em Conexões › API Oficial (Meta), depois que o número é conectado. Abra Conexões em outra aba, para não perder o token desta página.")}{" "}
          {/*
            Outra aba de propósito: o token recém-gerado vive só nesta página, e
            a URL de callback só em Conexões. Na mesma aba a pessoa perde o token
            no caminho — e copiar a URL depois sobrescreve a área de transferência.
          */}
          <Link
            href="/app/connections?aba=oficial"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="meta-abrir-conexoes"
            className="font-medium text-foreground underline underline-offset-2"
          >
            {t("Abrir Conexões em outra aba")}
          </Link>
        </p>

        {temSegredoSalvo ? (
          <div className="flex justify-end">
            <Button
              variant="outline"
              data-testid="meta-gerar-token"
              disabled={ocupado}
              // Sem token gravado não há o que derrubar: gera direto. Com token,
              // a troca invalida o que está colado na Meta e pede confirmação.
              onClick={() => (temTokenSalvo ? setConfirmandoTroca(true) : gerarToken())}
            >
              {temTokenSalvo ? t("Gerar novo token") : t("Gerar token")}
            </Button>
          </div>
        ) : null}
      </Card>

      {social ? (
        <Card className="flex flex-col gap-4 p-4" data-testid="meta-social-config">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">{t("Instagram Direct e Messenger")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("Para as empresas conectarem o Instagram e a Página do Facebook em Conexões › Redes sociais. A chave secreta do aplicativo, acima, vale para os dois.")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-app-id">{t("ID do app da Meta")}</Label>
            <Input
              id="meta-app-id"
              data-testid="meta-app-id"
              inputMode="numeric"
              autoComplete="off"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder={t("Só números, em Configurações do app › Básico")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-unified-config-id">{t("ID da configuração do login unificado")}</Label>
            <Input
              id="meta-unified-config-id"
              data-testid="meta-unified-config-id"
              inputMode="numeric"
              autoComplete="off"
              value={configId}
              onChange={(e) => setConfigId(e.target.value)}
              placeholder={t("Só números, em Instagram › API com login unificado › Configurações")}
            />
            <p className="text-xs text-muted-foreground">
              {t("É o que o Instagram usa para conectar, junto com o ID e a chave do app da Meta. Não é segredo.")}
            </p>
          </div>

          <div className="flex justify-end">
            <Button data-testid="meta-social-salvar" disabled={!podeSalvarSocial || ocupado} onClick={salvarSocial}>
              {ocupado ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium">{t("Endereços para cadastrar no painel da Meta")}</h3>
            {social.enderecos.map((e) => (
              <div key={e.url} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t(e.rotulo)}</span>
                <div className="flex items-center gap-2">
                  <Input readOnly value={e.url} className="font-mono text-xs" onFocus={(ev) => ev.currentTarget.select()} />
                  <Button variant="outline" onClick={() => void copiar(e.url)} aria-label={`${t("Copiar")}: ${t(e.rotulo)}`}>
                    {t("Copiar")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <AlertDialog open={confirmandoTroca} onOpenChange={setConfirmandoTroca}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Gerar um novo token de verificação?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O token atual deixa de valer na hora. As mensagens que já chegam continuam chegando, porque elas são conferidas pela chave secreta. O que muda: a Meta só consegue confirmar o endereço do webhook de novo depois que você colar o token novo no painel dela.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction data-testid="meta-confirmar-novo-token" onClick={gerarToken}>
              {t("Gerar novo token")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
