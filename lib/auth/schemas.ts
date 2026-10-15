import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * O nome da empresa, com a MESMA régua nos dois caminhos que o aceitam: o
 * cadastro e a recuperação do primeiro acesso. Enquanto a regra morava dentro
 * do `signupSchema`, a segunda teria de repeti-la — e duas cópias divergem na
 * primeira mudança.
 */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "Nome da empresa deve ter pelo menos 2 caracteres")
  .max(120, "Nome da empresa deve ter no máximo 120 caracteres");

const signupBase = {
  org_name: organizationNameSchema,
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
  password_confirm: z.string(),
  /** Dica do `?plano=` do site (ver `lib/auth/plano-escolhido.ts`); a ação sanitiza de novo. */
  plano_escolhido: z.string().max(40).optional(),
};

const senhasCoincidem = {
  path: ["password_confirm"],
  message: "As senhas não coincidem",
};

/**
 * O cadastro com o aceite dos Termos de Uso e da Política de Privacidade OBRIGATÓRIO. Mora no schema (e
 * não só na tela) porque a ação é chamável direto: quem decide é o servidor. A versão e a data do aceite
 * são do servidor (`signUp.ts`), nunca deste campo.
 *
 * O aceite só é exigido com a compra pelo cliente LIGADA (o caminho "paga primeiro"; ver
 * `signupSchemaDe`): instalação com a compra desligada cadastra exatamente como antes, sem checkbox novo.
 */
const signupComAceite = z
  .object({
    ...signupBase,
    aceite_termos: z.literal(true, {
      error: "Aceite os Termos de Uso e a Política de Privacidade para criar a conta",
    }),
  })
  .refine((v) => v.password === v.password_confirm, senhasCoincidem);

/** O mesmo cadastro, sem o campo do aceite (o campo, se vier, é descartado). */
const signupSemAceite = z
  .object(signupBase)
  .refine((v) => v.password === v.password_confirm, senhasCoincidem);

/** Hiperbold: com a compra pelo cliente ligada o aceite é obrigatório; desligada, o cadastro é o de antes. */
export function signupSchemaDe(exigeAceite: boolean) {
  return exigeAceite ? signupComAceite : signupSemAceite;
}

/** O contrato com aceite obrigatório (caminho "paga primeiro"). */
export const signupSchema = signupComAceite;

export type SignupInput = z.infer<typeof signupSchema>;
/** O cadastro quando a compra pelo cliente está desligada: o mesmo, sem o aceite. */
export type SignupSemAceiteInput = z.infer<typeof signupSemAceite>;

/**
 * Signup de quem foi CONVIDADO: a empresa já existe, então pedir o nome dela
 * seria pedir para a pessoa batizar a organização de outra gente.
 *
 * É um schema à parte, e não `org_name` opcional no de cima, de propósito: o
 * caminho normal continua exigindo o nome, com a mesma mensagem, e nada no
 * fluxo de quem abre a própria empresa afrouxa por causa deste.
 */
export const signupComConviteSchema = z
  .object({
    /**
     * QUEM ENTRA POR CONVITE NUNCA TINHA ONDE DIZER O PRÓPRIO NOME.
     *
     * O dono da instalação preenche o nome no onboarding; quem é convidado pula
     * o onboarding inteiro e ficava sem nome para sempre. Medido em produção em
     * 2026-09-10: no diálogo de transferir conversa, o colega aparecia como
     * "Atendente 528ebd09" — um pedaço do identificador interno, para a equipe
     * toda, indefinidamente.
     *
     * É o campo de UMA linha que fecha isso na origem, em vez de cada tela
     * inventar o próprio remendo para a ausência.
     */
    full_name: z.string().trim().min(2, "Informe seu nome").max(120),
    email: z.string().email("Email inválido"),
    password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
    password_confirm: z.string(),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  });

export type SignupComConviteInput = z.infer<typeof signupComConviteSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email("Email inválido"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, "Senha deve ter pelo menos 8 caracteres")
      .regex(/[A-Za-zÀ-ÿ]/, "Senha deve ter pelo menos uma letra")
      .regex(/[0-9]/, "Senha deve ter pelo menos um número")
      .regex(/[^A-Za-zÀ-ÿ0-9\s]/, "Senha deve ter pelo menos um símbolo"),
    password_confirm: z.string(),
    // Código TOTP: só exigido quando a conta tem MFA (a sessão de recovery é
    // AAL1 e o GoTrue pede AAL2 para trocar a senha). Opcional no schema; a
    // action decide se é obrigatório.
    mfa_code: z.string().optional(),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
