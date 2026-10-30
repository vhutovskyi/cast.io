import { ACCOUNT_NAME, type AccountUser, type SetNameError, type SetNameRequest, type SignInProvider, type SignInProvidersResponse } from "@ligma/backend/shared/accounts";
import { client } from "../net/client";

const PROVIDER_LABELS: Record<SignInProvider, string> = { discord: "Discord", google: "Google" };

/** "On 29 Nov you can change your name again." The date leads: some locales end a short month with a period. */
const cooldownNote = (at: number) =>
  `On ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} you can change your name again.`;

const NAME_ERRORS: Record<Exclude<SetNameError, "name_cooldown">, string> = {
  name_taken: "Someone already has that name.",
  name_invalid: `Names are ${ACCOUNT_NAME.minLength}–${ACCOUNT_NAME.maxLength} characters.`,
};

/** The account line under the nickname, and the sign-in dialog with its two steps. */
export interface AccountUi {
  /** "Ranked as Ann · Rename · Sign out", or "Sign in to play ranked". */
  line: HTMLElement;
  dialog: HTMLDialogElement;
  title: HTMLElement;
  /** Step one: a "Continue with …" button per provider the server offers. */
  signInStep: HTMLElement;
  providers: HTMLElement;
  /** Step two (and Rename): the ranked name others see. */
  nameStep: HTMLFormElement;
  nameInput: HTMLInputElement;
  nameSave: HTMLButtonElement;
  /** Why something didn't work, or that the server offers no sign-in. */
  note: HTMLElement;
  close: HTMLButtonElement;
}

/**
 * Who the player is for ranked play: signed in with Discord or Google, the
 * session remembered by `client.auth` (and checked with the server on load).
 * Ratings and dodge lockouts belong to the account, not to this browser. The
 * name others see is one the player picks — nothing from the provider.
 */
export class AccountPanel {
  user: AccountUser | null = null;
  private offered: SignInProvider[] = [];
  /** What to do once the player is signed in and named (search for a ranked duel). */
  private then: (() => void) | undefined;

  constructor(private readonly ui: AccountUi, private readonly suggestName: () => string, private readonly onSignOut: () => void) {
    ui.close.addEventListener("click", () => ui.dialog.close());
    // The dialog's content fills it edge to edge, so a click on the dialog itself is on the backdrop.
    ui.dialog.addEventListener("click", (e) => { if (e.target === ui.dialog) { ui.dialog.close(); } });
    ui.dialog.addEventListener("close", () => this.then = undefined);
    ui.nameInput.minLength = ACCOUNT_NAME.minLength;
    ui.nameInput.maxLength = ACCOUNT_NAME.maxLength;
    ui.nameStep.addEventListener("submit", (e) => {
      e.preventDefault();
      this.saveName();
    });
    client.auth.onChange(({ user }) => {
      this.user = user as AccountUser | null;
      this.render();
    });
    client.http.get("/auth/providers")
      .then(({ data }) => this.offered = (data as SignInProvidersResponse).providers)
      .catch((): SignInProvider[] => this.offered = [])
      .finally(() => this.renderProviders());
    this.render();
  }

  /** Runs `then` once signed in with a chosen name: straight away, or after the dialog. */
  requireSignIn(then: () => void) {
    if (this.user?.named) { then(); return; }
    this.then = then;
    this.showStep(this.user ? "name" : "signIn");
    this.ui.dialog.showModal();
  }

  private showStep(step: "signIn" | "name") {
    const { ui } = this;
    ui.note.textContent = "";
    ui.signInStep.hidden = step !== "signIn";
    ui.nameStep.hidden = step !== "name";
    ui.title.textContent = step === "signIn" ? "Sign in to play ranked" : "Choose your ranked name";
    if (step === "signIn") {
      this.renderProviders();
      return;
    }
    ui.nameInput.value = this.user?.named ? this.user.name : this.suggestName();
    // Changed recently: say until when, rather than refuse on Save. (The server checks anyway.)
    const waiting = (this.user?.renameAvailableAt ?? 0) > Date.now();
    ui.nameInput.disabled = waiting;
    ui.nameSave.disabled = waiting;
    if (waiting) {
      ui.note.textContent = cooldownNote(this.user!.renameAvailableAt);
    } else {
      ui.nameInput.focus();
    }
  }

  private async signIn(provider: SignInProvider) {
    this.ui.note.textContent = "";
    try {
      const { user } = await client.auth.signInWithProvider<AccountUser>(provider);
      this.user = user;
      this.render();
      if (user.named) {
        this.finish();
      } else {
        this.showStep("name");
      }
    } catch (e) {
      // Closing the popup is a change of mind, not an error.
      if (e !== "cancelled") {
        this.ui.note.textContent = `Couldn't sign in with ${PROVIDER_LABELS[provider]} (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
  }

  private async saveName() {
    this.ui.note.textContent = "";
    try {
      const { data } = await client.http.post("/auth/name", { body: { name: this.ui.nameInput.value } satisfies SetNameRequest });
      this.user = (data as { user: AccountUser }).user;
      this.render();
      this.finish();
    } catch (e) {
      const error = (e as { data?: { error?: SetNameError } }).data?.error;
      this.ui.note.textContent = error === "name_cooldown" ? cooldownNote(this.user?.renameAvailableAt ?? 0)
        : (error && NAME_ERRORS[error]) ?? `Couldn't save that name (${e instanceof Error ? e.message : String(e)}).`;
    }
  }

  /** Signed in and named: close the dialog and carry on with what it was opened for. */
  private finish() {
    const then = this.then;
    this.ui.dialog.close();
    then?.();
  }

  private render() {
    const { line } = this.ui;
    line.replaceChildren();
    const linkButton = (label: string, onClick: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-button";
      button.textContent = label;
      button.addEventListener("click", onClick);
      return button;
    };
    if (this.user) {
      const name = document.createElement("strong");
      // Player-chosen: text only.
      name.textContent = this.user.name;
      line.append(
        "Ranked as ", name, " · ",
        linkButton("Rename", () => {
          this.then = undefined;
          this.showStep("name");
          this.ui.dialog.showModal();
        }),
        " · ",
        linkButton("Sign out", () => {
          client.auth.signOut();
          this.onSignOut();
        }),
      );
    } else {
      line.append(linkButton("Sign in", () => this.requireSignIn(() => {})), " to play ranked");
    }
  }

  private renderProviders() {
    this.ui.providers.replaceChildren(...this.offered.map((provider) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn-secondary sign-in-${provider}`;
      button.textContent = `Continue with ${PROVIDER_LABELS[provider]}`;
      button.addEventListener("click", () => this.signIn(provider));
      return button;
    }));
    if (this.offered.length === 0 && !this.ui.signInStep.hidden) { this.ui.note.textContent = "Ranked sign-in isn't set up on this server yet."; }
  }
}
