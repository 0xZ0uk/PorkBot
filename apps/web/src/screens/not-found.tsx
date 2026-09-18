/** A route that does not exist, in the same frame as every other screen. */
export function NotFoundScreen() {
  return (
    <main id="main" className="screen" tabIndex={-1}>
      <div className="card">
        <h1>Page not found</h1>
        <p className="muted">That page does not exist.</p>
      </div>
    </main>
  );
}
