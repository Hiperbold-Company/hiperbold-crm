"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  pedirInicioDoCadastroIncorporado,
  useFinalizarCadastroIncorporado,
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
      extras: { setup: Record<string, never>; sessionInfoVersion: string };
    },
  ): void;
}

type JanelaComSdk = Window & { FB?: SdkDaMeta; fbAsyncInit?: () => void };

const URL_DO_SDK = "https://connect.facebook.net/en_US/sdk.js";
const ESPERA_DO_SDK_MS = 15_000;
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
  jaConectado,
  bloqueio,
}: {
  /** Já existe um canal oficial nesta organização: o botão passa a TROCAR o número. */
  jaConectado: boolean;
  bloqueio?: BloqueioDoBotao;
}) {
  const t = useT();
  const finalizar = useFinalizarCadastroIncorporado();
  const [nome, setNome] = useState("");
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
  const travadoPeloPlano = !jaConectado && Boolean(bloqueio?.desabilitado);

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
        setNome("");
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
    setErro(null);
    setAviso(null);

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
          extras: { setup: {}, sessionInfoVersion: "3" },
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

        {jaConectado ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "Esta organização tem uma conexão oficial; conectar outro número pela Meta substitui a atual.",
            )}
          </p>
        ) : null}

        <div>
          <Button
            type="button"
            onClick={aoClicar}
            disabled={ocupado || travadoPeloPlano}
            title={travadoPeloPlano ? (bloqueio?.motivo ?? undefined) : undefined}
            data-testid="btn-conectar-meta"
          >
            {fase === "abrindo"
              ? t("Abrindo a Meta…")
              : fase === "conectando"
                ? t("Conectando o número…")
                : jaConectado
                  ? t("Trocar número pela Meta")
                  : t("Conectar com a Meta")}
          </Button>
        </div>

        {travadoPeloPlano ? (
          <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} className="text-xs text-destructive" />
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

        {aviso ? (
          <p
            role="status"
            data-testid="cadastro-meta-aviso"
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
          >
            {aviso}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
