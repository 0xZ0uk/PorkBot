import { AuthRefusal } from "./session.ts";

/**
 * The one place a refusal becomes a sentence. The transport and the controller
 * carry reasons, not copy, so the shell shows the server's own sentence for a
 * refusal and owns the two cases the server cannot speak to: a deployment that
 * cannot be reached and a sign-in that produced no session.
 */
export function authErrorMessage(error: unknown): string {
  if (error instanceof AuthRefusal) {
    switch (error.reason) {
      case "unreachable":
        return "Can’t reach the server. Try again.";
      case "not_signed_in":
        return "Signing in did not complete. Try again.";
      case "refused":
        return error.message;
    }
  }

  return "Something went wrong. Try again.";
}
