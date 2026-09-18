/**
 * The bootstrapping state: what the router shows while a guard awaits the
 * session read. The SPA shell also prerenders this component, so the first
 * paint says what is happening instead of showing an empty document.
 */
export function BootstrappingScreen() {
  return (
    <main id="main" className="screen" tabIndex={-1}>
      <p className="muted" role="status">
        Checking your session…
      </p>
    </main>
  );
}
