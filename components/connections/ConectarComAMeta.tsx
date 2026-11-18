"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  pedirInicioDoCadastroIncorporado,
  useFinalizarCadastroIncorporado,
  useSincronizarContatosDoApp,
  type InicioDoCadastroIncorporado,
} from "@/hooks/channels/useCadastroIncorporado";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import {
  lerEventoDoCadastroIncorporado,
  type EventoDoCadastroIncorporado,
} from "@/lib/channels/meta/cadastro-incorporado/evento";
import { AvisoDeLimiteDeConexoes } from "./AvisoDeLimiteDeConexoes";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";

/* ───────────── SDK da Meta (tipos mínimos, só o que usamos) ───────────── */

interface RespostaDoLogin {
  authResponse?: { code?: string } | null;
}

interface SdkDaMeta {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (resposta: RespostaDoLogin) => void,
    opts: {
      config_id: string;
      response_type: "code";
      override_default_response_type: boolean;
      extras: { setup: Record<string, never>; sessionInfoVersion: string; featureType?: string };
    },
  ): void;
}

type JanelaComSdk = Window & { FB?: SdkDaMeta; fbAsyncInit?: () => void };

const URL_DO_SDK = "https://connect.facebook.net/en_US/sdk.js";
const ESPERA_DO_SDK_MS = 15_000;
/** O `featureType` que a Meta pede para ligar um número que já usa o app WhatsApp Business (coexistência). */
const FEATURE_DA_COEXISTENCIA = "whatsapp_business_app_onboarding";
/** O servidor aceita o state por 15 min; aqui se renova antes, aos 10. */
const IDADE_MAXIMA_DO_STATE_MS = 10 * 60_000;
/** O `code` do login vale 30 s: o evento do popup tem de chegar bem antes disso. */
const ESPERA_DO_EVENTO_MS = 10_000;
/** Sem `code` (cancelou), o evento CANCEL/ERROR só melhora a mensagem: não vale esperar muito. */
const ESPERA_DA_RAZAO_MS = 1_500;

let sdkEmCarga: Promise<SdkDaMeta> | null = null;

function carregarSdk(): Promise<SdkDaMeta> {
  const janela = window as JanelaComSdk;
  if (janela.FB) return Promise.resolve(janela.FB);
  if (sdkEmCarga) return sdkEmCarga;

  sdkEmCarga = new Promise<SdkDaMeta>((resolve, reject) => {
    const falhar = (script?: HTMLScriptElement) => {
      script?.remove();
      sdkEmCarga = null; // permite tentar de novo no próximo clique
      reject(new Error("sdk_indisponivel"));
    };
    const script = document.createElement("script");
    const timer = window.setTimeout(() => falhar(script), ESPERA_DO_SDK_MS);
    janela.fbAsyncInit = () => {
      window.clearTimeout(timer);
      if (janela.FB) resolve(janela.FB);
      else falhar(script);
    };
    script.src = URL_DO_SDK;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      window.clearTimeout(timer);
      falhar(script);
    };
    document.body.appendChild(script);
  });
  return sdkEmCarga;
}

/**
 * Escuta o popup da Meta ANTES do `FB.login`. A mensagem pode chegar antes ou depois do callback
 * do login, por isso o primeiro evento terminal fica guardado e quem espera o recebe na hora.
 */
function escutarOEvento() {
  let guardado: EventoDoCadastroIncorporado | null = null;
  let entregar: ((e: EventoDoCadastroIncorporado) => void) | null = null;

  const ouvinte = (event: MessageEvent) => {
    const lido = lerEventoDoCadastroIncorporado(event.origin, event.data);
    if (!lido || guardado) return;
    guardado = lido;
    entregar?.(lido);
  };
  window.addEventListener("message", ouvinte);

  return {
    /** Resolve com o evento, ou `null` se nada chegou no prazo. */
    esperar(ms: number): Promise<EventoDoCadastroIncorporado | null> {
      if (guardado) return Promise.resolve(guardado);
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          entregar = null;
          resolve(null);
        }, ms);
        entregar = (e) => {
          window.clearTimeout(timer);
          entregar = null;
          resolve(e);
        };
      });
    },
    parar() {
      window.removeEventListener("message", ouvinte);
      entregar = null;
    },
  };
}

type Fase = "ocioso" | "abrindo" | "conectando";
type InicioDisponivel = Extract<InicioDoCadastroIncorporado, { disponivel: true }>;
/** O início guardado, com a hora em que chegou. De uso único: sai daqui no clique. */
interface Preparado {
  inicio: InicioDisponivel;
  em: number;
}

export function ConectarComAMeta({
  bloqueio,
  temConexaoOficial = false,
}: {
  /**
   * Desde 17/11/2026 cada número NOVO conectado pela Meta é uma conexão nova (várias contas oficiais
   * por organização): o botão nunca substitui a atual.
   */
  bloqueio?: BloqueioDoBotao;
  /**
   * A organização já tem conexão oficial: no teto do plano o botão continua livre, porque reautenticar
   * o MESMO número reaproveita a linha dele. Número novo segue barrado pelo servidor (trigger do plano),
   * e a recusa chega com a mensagem da rota.
   */
  temConexaoOficial?: boolean;
}) {
  const t = useT();
  const finalizar = useFinalizarCadastroIncorporado();
  const sincronizar = useSincronizarContatosDoApp();
  const [nome, setNome] = useState("");
  /** Modo "coexistência" escolhido (o número já usa o app WhatsApp Business). Lido no render, sem `await`. */
  const [coexistencia, setCoexistencia] = useState(false);
  /**
   * LGPD: a coexistência traz a agenda e as conversas do celular para o CRM. Só abre o popup depois de a
   * pessoa marcar que sabe disso. Não vale de uma conexão para a outra: volta a desmarcada.
   */
  const [confirmouContatos, setConfirmouContatos] = useState(false);
  /** A Meta recusou (ou não respondeu) a sincronização dos contatos do app: a sessão a tentar de novo. */
  const [sincronizacaoPendente, setSincronizacaoPendente] = useState<string | null>(null);
  const [erroDaSincronizacao, setErroDaSincronizacao] = useState<string | null>(null);
  const [fase, setFase] = useState<Fase>("ocioso");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** O operador clicou antes de o início estar pronto: mostra o aviso até a preparação terminar. */
  const [esperando, setEsperando] = useState(false);
  const clicouSemPreparo = useRef(false);
  const [semConfiguracao, setSemConfiguracao] = useState(false);
  const montado = useRef(true);
  const preparado = useRef<Preparado | null>(null);
  const buscando = useRef(false);

  /**
   * O popup só abre se `FB.login` sair no MESMO tique do clique (Safari bloqueia depois de um `await`).
   * Por isso o início (state, appId, configId, versão) e o SDK são preparados ANTES, e o clique só lê
   * o que já está guardado. O state é de uso único: quem o usa o apaga, e esta função busca outro.
   */
  async function preparar() {
    if (buscando.current) return;
    buscando.current = true;
    try {
      const inicio = await pedirInicioDoCadastroIncorporado();
      if (!inicio.disponivel) {
        preparado.current = null;
        if (montado.current) setSemConfiguracao(true);
        return;
      }
      if (montado.current) setSemConfiguracao(false);
      const em = Date.now();
      const sdk = await carregarSdk();
      sdk.init({
        appId: inicio.appId,
        autoLogAppEvents: false,
        xfbml: false,
        version: inicio.versaoDaGraph,
      });
      preparado.current = { inicio, em };
    } catch {
      // Sem rede ou SDK bloqueado. Só incomoda quem já clicou; o próximo clique tenta de novo.
      preparado.current = null;
      if (clicouSemPreparo.current && montado.current) {
        setErro(
          t("Não foi possível carregar o login da Meta. Desative bloqueadores de anúncio e tente de novo."),
        );
      }
    } finally {
      buscando.current = false;
      clicouSemPreparo.current = false;
      if (montado.current) setEsperando(false);
    }
  }

  useEffect(() => {
    montado.current = true;
    const inicial = window.setTimeout(() => void preparar(), 0);
    // Um state parado por mais de 10 min é renovado sem esperar o clique.
    const relogio = window.setInterval(() => {
      const p = preparado.current;
      if (p && Date.now() - p.em > IDADE_MAXIMA_DO_STATE_MS) void preparar();
    }, 60_000);
    return () => {
      montado.current = false;
      window.clearTimeout(inicial);
      window.clearInterval(relogio);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao montar; `preparar` só lê refs e setters estáveis
  }, []);

  const ocupado = fase !== "ocioso";
  const travadoPeloPlano = !temConexaoOficial && Boolean(bloqueio?.desabilitado);
  const soReconectar = temConexaoOficial && Boolean(bloqueio?.desabilitado);
  const faltaConfirmarContatos = coexistencia && !confirmouContatos;

  function falhar(mensagem: string) {
    if (!montado.current) return;
    setErro(mensagem);
    setFase("ocioso");
  }

  function mensagemDoEvento(e: EventoDoCadastroIncorporado): string | null {
    if (e.tipo === "cancelado") {
      const etapa = e.etapa ? ` (${t("etapa")}: ${e.etapa})` : "";
      return `${t("Você fechou o cadastro da Meta antes de terminar")}${etapa}. ${t("Nada foi conectado.")}`;
    }
    if (e.tipo === "erro") return `${t("A Meta recusou o cadastro:")} ${e.mensagem}`;
    return null;
  }

  /** Tudo o que vem DEPOIS de o popup abrir. O state já foi tirado do guardado e não volta. */
  async function concluir(
    inicio: InicioDisponivel,
    codigo: Promise<string | null>,
    escuta: ReturnType<typeof escutarOEvento>,
  ) {
    try {
      const code = await codigo;

      if (!code) {
        // Cancelar o popup também posta CANCEL/ERROR: quando chega, diz mais que o aviso genérico.
        const razao = await escuta.esperar(ESPERA_DA_RAZAO_MS);
        return falhar(
          (razao && mensagemDoEvento(razao)) ||
            t("Login com a Meta cancelado ou sem permissão concedida."),
        );
      }

      if (montado.current) setFase("conectando");
      const evento = await escuta.esperar(ESPERA_DO_EVENTO_MS);

      const razao = evento ? mensagemDoEvento(evento) : null;
      if (razao) return falhar(razao);
      if (evento?.tipo !== "finalizado" || !evento.phoneNumberId) {
        return falhar(
          t(
            "A Meta não devolveu o número escolhido. Tente de novo e escolha um número no fim do cadastro.",
          ),
        );
      }

      const nomeLimpo = nome.trim();
      const r = await finalizar.mutateAsync({
        state: inicio.state,
        code,
        phone_number_id: evento.phoneNumberId,
        ...(evento.wabaId ? { waba_id: evento.wabaId } : {}),
        ...(nomeLimpo ? { nome: nomeLimpo } : {}),
        evento: evento.evento,
      });

      toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
      if (montado.current) {
        if (r.data.precisaRegistrar === true) {
          setAviso(t("Falta ativar o número: use o botão Registrar no cartão do número."));
        }
        // `false` = a Meta recusou a sincronização dos contatos do app: a conexão vale, mas a tela avisa
        // e oferece tentar de novo. `null`/`true`/ausente: nada a dizer.
        if (r.data.sincronizacaoDoApp === false && r.data.channelSessionId) {
          setSincronizacaoPendente(r.data.channelSessionId);
          setErroDaSincronizacao(null);
        }
        setNome("");
        setConfirmouContatos(false);
        setFase("ocioso");
      }
    } catch (e) {
      // `error.message` da rota já vem em português; o resto cai numa frase genérica.
      falhar(
        e instanceof ApiError && e.message
          ? e.message
          : t("Não foi possível concluir o cadastro. Tente de novo."),
      );
    } finally {
      escuta.parar();
      // O state queimou (no POST ou ao abrir o popup), com sucesso ou erro: já deixa outro pronto.
      void preparar();
    }
  }

  /**
   * SÍNCRONO de propósito: sem `await` antes do `FB.login`. Se não há state fresco e SDK carregado,
   * avisa, dispara a preparação e NÃO abre nada: o próximo clique abre.
   */
  function aoClicar() {
    if (faltaConfirmarContatos) return;
    setErro(null);
    setAviso(null);
    setSincronizacaoPendente(null);
    setErroDaSincronizacao(null);

    const guardado = preparado.current;
    const sdk = (window as JanelaComSdk).FB;
    const fresco = guardado !== null && Date.now() - guardado.em <= IDADE_MAXIMA_DO_STATE_MS;
    if (!guardado || !fresco || !sdk) {
      preparado.current = null;
      clicouSemPreparo.current = true;
      setEsperando(true);
      void preparar();
      return;
    }

    preparado.current = null; // uso único
    const { inicio } = guardado;
    const escuta = escutarOEvento();
    let codigo: Promise<string | null>;
    try {
      codigo = new Promise<string | null>((resolve) => {
        // O executor da Promise roda na hora: o login sai neste mesmo tique.
        sdk.login((resposta) => resolve(resposta.authResponse?.code ?? null), {
          config_id: inicio.configId,
          response_type: "code",
          override_default_response_type: true,
          extras: coexistencia
            ? { setup: {}, sessionInfoVersion: "3", featureType: FEATURE_DA_COEXISTENCIA }
            : { setup: {}, sessionInfoVersion: "3" },
        });
      });
    } catch {
      escuta.parar();
      falhar(t("Não foi possível abrir o login da Meta. Tente de novo."));
      void preparar();
      return;
    }
    setFase("abrindo");
    void concluir(inicio, codigo, escuta);
  }

  async function tentarSincronizarDeNovo() {
    if (!sincronizacaoPendente) return;
    setErroDaSincronizacao(null);
    try {
      const r = await sincronizar.mutateAsync({ channel_session_id: sincronizacaoPendente });
      if (!montado.current) return;
      if (r.data.sincronizado) {
        toast.success(t("Contatos do WhatsApp Business solicitados."));
        setSincronizacaoPendente(null);
      } else {
        setErroDaSincronizacao(
          r.data.motivo ?? t("A Meta não aceitou trazer os contatos agora. Tente de novo em instantes."),
        );
      }
    } catch (e) {
      if (!montado.current) return;
      setErroDaSincronizacao(
        e instanceof ApiError && e.message
          ? e.message
          : t("Não foi possível pedir os contatos agora. Tente de novo."),
      );
    }
  }

  const mostrarPreparando = esperando && !semConfiguracao;

  return (
    <Card className="p-4" data-testid="cadastro-meta-card">
      <h2 className="font-medium">{t("Conectar com a Meta")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "Entre com a sua conta da Meta e escolha o número. O CRM guarda a credencial e configura o recebimento de mensagens sozinho.",
        )}
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cadastro-meta-nome">{t("Nome da conexão (opcional)")}</Label>
          <Input
            id="cadastro-meta-nome"
            data-testid="cadastro-meta-nome"
            value={nome}
            maxLength={80}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t("Ex.: Comercial")}
            disabled={ocupado}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("Tipo de conexão")}>
            <Button
              type="button"
              size="sm"
              variant={coexistencia ? "outline" : "default"}
              aria-pressed={!coexistencia}
              onClick={() => {
                setCoexistencia(false);
                setConfirmouContatos(false);
              }}
              disabled={ocupado}
              data-testid="cadastro-meta-modo-padrao"
            >
              {t("Conexão padrão")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={coexistencia ? "default" : "outline"}
              aria-pressed={coexistencia}
              onClick={() => setCoexistencia(true)}
              disabled={ocupado}
              data-testid="cadastro-meta-modo-coexistencia"
            >
              {t("Conexão em coexistência")}
            </Button>
          </div>
          {coexistencia ? (
            <div
              data-testid="cadastro-meta-explicacao-coexistencia"
              className="rounded-md border border-warning/30 bg-warning-bg p-3 text-sm"
            >
              <p className="font-medium">{t("Conexão em coexistência")}</p>
              <p className="mt-1 text-muted-foreground">
                {t(
                  "Para um número que já funciona no app WhatsApp Business. A Meta mostra o número do app e pede para ler um QR Code no WhatsApp Business do celular. O número continua funcionando no app.",
                )}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t("Recurso recente da Meta: se a conexão falhar, use a conexão padrão.")}
              </p>
              <p className="mt-2 font-medium" data-testid="cadastro-meta-aviso-contatos">
                {t(
                  "Os contatos e as conversas dos últimos 6 meses do WhatsApp Business deste número vão aparecer no CRM para a sua equipe.",
                )}
              </p>
              <label className="mt-2 flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={confirmouContatos}
                  onChange={(e) => setConfirmouContatos(e.target.checked)}
                  disabled={ocupado}
                  className="mt-0.5"
                  data-testid="cadastro-meta-confirma-contatos"
                />
                <span>{t("Entendi e autorizo trazer esses contatos e conversas para o CRM.")}</span>
              </label>
            </div>
          ) : (
            <div
              data-testid="cadastro-meta-explicacao-padrao"
              className="rounded-md border bg-muted/30 p-3 text-sm"
            >
              <p className="font-medium">{t("Conexão padrão")}</p>
              <p className="mt-1 text-muted-foreground">
                {t(
                  "Para um número novo ou que ainda não está no app WhatsApp Business. O número passa a funcionar só pela API oficial.",
                )}
              </p>
            </div>
          )}
        </div>

        <div>
          <Button
            type="button"
            onClick={aoClicar}
            disabled={ocupado || travadoPeloPlano || faltaConfirmarContatos}
            title={travadoPeloPlano ? (bloqueio?.motivo ?? undefined) : undefined}
            data-testid="btn-conectar-meta"
          >
            {fase === "abrindo"
              ? t("Abrindo a Meta…")
              : fase === "conectando"
                ? t("Conectando o número…")
                : t("Conectar com a Meta")}
          </Button>
        </div>

        {travadoPeloPlano ? (
          <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} className="text-xs text-destructive" />
        ) : null}

        {soReconectar ? (
          <p className="text-xs text-muted-foreground" data-testid="cadastro-meta-so-reconectar">
            {t("O plano chegou ao limite de conexões: dá para entrar de novo com um número que já está conectado, mas não para conectar um número novo.")}
          </p>
        ) : null}

        {semConfiguracao ? (
          <p className="text-sm text-muted-foreground" data-testid="cadastro-meta-nao-configurado">
            {t(
              "O botão ainda não está configurado nesta instalação. Quem administra a instalação cadastra o app da Meta em Administração › Meta.",
            )}
          </p>
        ) : null}

        {mostrarPreparando ? (
          <p role="status" data-testid="cadastro-meta-preparando" className="text-sm text-muted-foreground">
            {t("Preparando a conexão com a Meta, clique de novo em instantes.")}
          </p>
        ) : null}

        {erro ? (
          <div
            role="alert"
            data-testid="cadastro-meta-erro"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {erro}
          </div>
        ) : null}

        {sincronizacaoPendente ? (
          <div
            role="alert"
            data-testid="cadastro-meta-sincronizacao-falhou"
            className="rounded-md border border-warning/30 bg-warning-bg p-3 text-sm"
          >
            <p>{t("A conexão funcionou, mas os contatos do WhatsApp Business não foram trazidos.")}</p>
            {erroDaSincronizacao ? (
              <p className="mt-1 text-muted-foreground" data-testid="cadastro-meta-sincronizacao-motivo">
                {erroDaSincronizacao}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void tentarSincronizarDeNovo()}
              disabled={sincronizar.isPending}
              data-testid="cadastro-meta-sincronizar-de-novo"
            >
              {sincronizar.isPending ? t("Tentando…") : t("Tentar de novo")}
            </Button>
          </div>
        ) : null}

        {aviso ? (
          <p
            role="status"
            data-testid="cadastro-meta-aviso"
            className="rounded-md border border-warning/30 bg-warning-bg p-3 text-sm"
          >
            {aviso}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
