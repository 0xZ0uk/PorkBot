/**
 * The signed-in home. Every later console screen (bots, runs, settings) grows
 * from here; for the shell slice it is the visible proof that the session
 * resolved to an actor and the guard let the route through.
 */
export function HomeScreen() {
  return (
    <>
      <h1>Home</h1>
      <p className="muted">Signed in.</p>
    </>
  );
}
