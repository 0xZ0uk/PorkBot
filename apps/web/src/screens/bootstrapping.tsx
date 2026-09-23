/**
 * The bootstrapping state: what the router shows while a guard awaits the
 * session read. The SPA shell also prerenders this component, so the first
 * paint says what is happening instead of showing an empty document.
 */
export function BootstrappingScreen() {
  return (
    <main
      id="main"
      className="flex min-h-full flex-col items-center justify-center gap-4 p-4"
      tabIndex={-1}
    >
      <p className="text-muted-foreground" role="status">
        Checking your session…
      </p>
    </main>
  );
}
