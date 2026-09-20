/**
 * The desktop's server address (slice 11.6).
 *
 * v1.0 desktop is connect-only: the app hosts the packaged build and dials the
 * operator's deployment. The address is the one setting the app has, it is
 * typed in the setup page, and this module is the only place it is parsed or
 * written, so a bad address is refused with a sentence that says what to fix
 * rather than failing later as an opaque network error.
 *
 * HTTPS is required because the session cookie and the operator's credentials
 * cross this connection; plain HTTP is allowed only for loopback, where a
 * developer runs the stack on the same machine and the traffic never leaves it.
 */

export type ServerOriginRefusal =
  "empty" | "malformed" | "insecure" | "has-credentials" | "has-path" | "unsupported-scheme";

export type ServerOriginResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly refusal: ServerOriginRefusal; readonly message: string };

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

const refusalMessages: Readonly<Record<ServerOriginRefusal, string>> = {
  empty: "Enter the address of your PorkBot server.",
  malformed: "That address could not be read. Try one like https://porkbot.example.com.",
  insecure: "The address must use HTTPS, unless it is on this machine (localhost).",
  "has-credentials": "Remove the username or password from the address.",
  "has-path": "Enter the server's root address, without a path.",
  "unsupported-scheme": "Only http and https addresses are supported.",
};

function refuse(refusal: ServerOriginRefusal): ServerOriginResult {
  return { ok: false, refusal, message: refusalMessages[refusal] };
}

/**
 * Parses an operator-typed address into its origin. A missing scheme is read as
 * HTTPS, because that is the only scheme a deployment can offer; the result is
 * `URL.origin`, so `https://host/` and `https://host` are the same setting.
 */
export function parseServerOrigin(input: string): ServerOriginResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return refuse("empty");
  }

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return refuse("malformed");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refuse("unsupported-scheme");
  }

  if (url.username !== "" || url.password !== "") {
    return refuse("has-credentials");
  }

  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return refuse("has-path");
  }

  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    return refuse("insecure");
  }

  return { ok: true, origin: url.origin };
}
