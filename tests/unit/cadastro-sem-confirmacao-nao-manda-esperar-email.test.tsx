/**
 * A TELA DO CADASTRO NÃO PODE MANDAR ESPERAR UM E-MAIL QUE NÃO VAI CHEGAR.
 *
 * Par do `app/actions/auth/signUp.test.ts`: lá se guarda que a action DIZ que a
 * sessão veio aberta; aqui, que a tela AGE sobre isso. Separados de propósito —
 * a action podia devolver `sessao_ativa` certinho e o formulário continuar
 * mostrando "confirme seu e-mail", que era exatamente o defeito medido, e um
 * teste só do lado da action ficaria verde com a pessoa presa do mesmo jeito.
 *
 * Medido na `origin/main` @ `4d50f63f` com `GOTRUE_MAILER_AUTOCONFIRM=true`: a
 * tela dizia "Enviamos um link de confirmação para …" enquanto o cookie de
 * sessão já estava no browser e o usuário não tinha organização nenhuma.
 * Achado de @KIRAzinx566, com um cliente real travado nessa tela.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignupForm } from "@/components/auth/SignupForm";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const signUp = vi.fn();
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: (...a: unknown[]) => signUp(...a) }));
const recoverOrganization = vi.fn();
vi.mock("@/app/actions/auth/recoverOrganization", () => ({
  recoverOrganization: (...a: unknown[]) => recoverOrganization(...a),
}));

/**
 * O erro que o Next 16 usa para entregar o redirect de uma server action ao CLIENTE: a promise da action
 * é REJEITADA com ele (`server-action-reducer.js`, `createRedirectErrorForAction`), é assim que a
 * navegação chega ao RedirectBoundary. Mesmo formato do digest real.
 */
function erroDeRedirect(destino: string): Error {
  return Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${destino};307;` });
}

async function preencherEEnviar(comEmpresa = true, comAceite = true) {
  const user = userEvent.setup();
  // Os dois caminhos pedem campos DIFERENTES: quem abre empresa informa o nome
  // DELA; quem chega por convite informa o nome DE SI — sem isso a pessoa
  // entrava na equipe sem nome e aparecia como um pedaço de identificador para
  // os colegas (medido em produção em 2026-09-10).
  if (comEmpresa) await user.type(screen.getByLabelText(/Nome da empresa/i), "Plata Iphones");
  else await user.type(screen.getByLabelText(/Seu nome/i), "Convidada da Silva");
  await user.type(screen.getByLabelText(/^Email$/i), "dono@plata.test");
  await user.type(screen.getByLabelText(/^Senha$/i), "SenhaForte!2026");
  await user.type(screen.getByLabelText(/Confirmar senha/i), "SenhaForte!2026");
  // O aceite dos Termos só existe no cadastro sem convite (quem abre empresa).
  if (comEmpresa && comAceite) await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: /criar conta/i }));
}

describe("cadastro quando o provedor já abriu a sessão (compra pelo cliente ligada)", () => {
  beforeEach(() => {
    replace.mockClear();
    signUp.mockReset();
    recoverOrganization.mockReset();
  });

  it("⭐ sessão já aberta: cria a empresa com o nome digitado, sem passar por /get-started", async () => {
    // O Next 16 entrega o redirect de uma server action ao cliente REJEITANDO a promise com NEXT_REDIRECT.
    // O formulário não pode tratar isso como falha: a navegação para /onboarding já está em curso.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    recoverOrganization.mockRejectedValue(erroDeRedirect("/onboarding"));
    render(<SignupForm compraLigada />);
    await preencherEEnviar();

    await waitFor(() => expect(recoverOrganization).toHaveBeenCalledWith("Plata Iphones"));
    // Deixa as continuações da promise rejeitada rodarem antes de afirmar a ausência do desvio.
    await new Promise((r) => setTimeout(r, 50));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Enviamos um link de confirmação/i)).toBeNull();
  });

  it("⭐ sessão já aberta e a criação recusada: leva à saída em vez de mandar abrir o e-mail", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    recoverOrganization.mockResolvedValue({ ok: false, error: "rate_limited" });
    render(<SignupForm compraLigada />);
    await preencherEEnviar();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/get-started"));
    // A instrução impossível não pode sobrar na tela junto do desvio.
    expect(screen.queryByText(/Enviamos um link de confirmação/i)).toBeNull();
  });

  it("⭐ falha de VERDADE ao criar a empresa (rejeição que não é redirect): cai na saída /get-started", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    recoverOrganization.mockRejectedValue(new Error("rede caiu"));
    render(<SignupForm compraLigada />);
    await preencherEEnviar();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/get-started"));
  });

  it("⭐ sessão já aberta COM convite: vai aceitar o convite, não abrir empresa", async () => {
    // Dar organização própria a quem foi convidado é o erro que
    // `decidirConviteDoSignup` existe para evitar. Um desvio que mandasse todo
    // mundo para `/get-started` ficaria verde no caso acima e recriaria esse
    // erro aqui.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    render(<SignupForm convite={{ token: "tok-123", email: "convidado@plata.test" }} />);
    await preencherEEnviar(false);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/team/accept-invite/tok-123"),
    );
    expect(recoverOrganization).not.toHaveBeenCalled();
  });

  it("CONTROLE — confirmação LIGADA: a tela do e-mail continua aparecendo", async () => {
    // Sem este caso, "sempre redireciona" ficaria verde e tiraria da tela a
    // única instrução correta para quem de fato precisa confirmar o e-mail.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: false });
    render(<SignupForm compraLigada />);
    await preencherEEnviar();

    await waitFor(() =>
      expect(screen.getByText(/Enviamos um link de confirmação/i)).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("cadastro com a compra pelo cliente DESLIGADA: o formulário de antes", () => {
  beforeEach(() => {
    replace.mockClear();
    signUp.mockReset();
    recoverOrganization.mockReset();
  });

  it("⭐ não pede o aceite dos Termos (sem checkbox) e o cadastro segue", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: false });
    render(<SignupForm />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await preencherEEnviar(true, false);

    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect(signUp.mock.calls[0]![0]).not.toHaveProperty("aceite_termos");
    await waitFor(() => expect(screen.getByText(/Enviamos um link de confirmação/i)).toBeTruthy());
  });

  it("⭐ sessão já aberta: vai a /get-started como sempre, sem criar a empresa pelo caminho 'paga primeiro'", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    render(<SignupForm />);
    await preencherEEnviar(true, false);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/get-started"));
    expect(recoverOrganization).not.toHaveBeenCalled();
  });

  it("CONTROLE — com a compra ligada o aceite é exigido: sem marcar, a ação nem é chamada", async () => {
    render(<SignupForm compraLigada />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    await preencherEEnviar(true, false);
    await new Promise((r) => setTimeout(r, 50));
    expect(signUp).not.toHaveBeenCalled();
  });
});
