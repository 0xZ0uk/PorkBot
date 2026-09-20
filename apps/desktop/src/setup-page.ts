/**
 * The desktop's first-run screen (slice 11.6).
 *
 * It is not a product screen and it is not rendered through the web build: it
 * is the one page the app needs before it can reach a server at all, so it
 * ships as plain HTML with a small inline script and the proxy serves it with
 * the same hashed content security policy as the shell. The copy is the
 * minimum: what to enter, and the refusal sentence when it is wrong.
 */

export const setupPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect PorkBot</title>
    <style>
      :root { color-scheme: dark; }
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 28rem; padding: 0 1rem; }
      form { display: grid; gap: 0.5rem; }
      input { padding: 0.5rem; }
      button { padding: 0.5rem 1rem; justify-self: start; }
    </style>
  </head>
  <body>
    <main id="main">
      <h1>Connect PorkBot</h1>
      <p>Enter the address of your PorkBot server.</p>
      <form>
        <label for="origin">Server address</label>
        <input id="origin" name="origin" type="text" autocomplete="url" placeholder="porkbot.example.com" required />
        <button type="submit">Connect</button>
      </form>
      <p role="status"></p>
    </main>
    <script>
      document.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const status = document.querySelector("[role=status]");
        status.textContent = "";
        const origin = document.querySelector("#origin").value;
        let response;
        try {
          response = await fetch("/__porkbot/server", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ origin }),
          });
        } catch {
          status.textContent = "The address could not be saved.";
          return;
        }
        if (response.ok) {
          location.assign("/");
          return;
        }
        const body = await response.json().catch(() => ({}));
        status.textContent = body.message || "The address could not be saved.";
      });
    </script>
  </body>
</html>
`;
