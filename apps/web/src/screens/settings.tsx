import { Link } from "@tanstack/react-router";

/**
 * The settings index (slice 11.5): one page that names every settings surface
 * and links to it, so the area has a door at every level and no surface is
 * reachable only by guessing a URL.
 *
 * The page is deliberately a directory, not a dashboard: each entry is one
 * line, the detail lives behind its link, and the copy says what the surface
 * is for rather than repeating the state it holds. Every link here has a route
 * beside it; a surface added without a line here would be a dead end for
 * anyone who did not know the path.
 */

/** The six surfaces, in the order an operator meets them. */
const sections = [
  {
    to: "/settings/connections",
    title: "Models",
    summary: "Endpoints, stored keys and the connection each bot uses.",
  },
  {
    to: "/settings/mcp",
    title: "MCP servers",
    summary: "Install a server by URL, see its tools and grant it to bots.",
  },
  {
    to: "/settings/secrets",
    title: "Secrets",
    summary: "Per-bot credentials and the one origin each may be sent to.",
  },
  {
    to: "/settings/notifications",
    title: "Notifications",
    summary: "Which runs and approvals interrupt you.",
  },
  {
    to: "/settings/usage",
    title: "Usage",
    summary: "Recorded token totals per bot and period.",
  },
  {
    to: "/settings/account",
    title: "Account",
    summary: "Your role and this deployment's owner.",
  },
] as const;

export function SettingsScreen() {
  return (
    <section className="console">
      <h2>Settings</h2>
      <ul className="settings-index">
        {sections.map((section) => (
          <li key={section.to} className="settings-index-item">
            <h3>
              <Link to={section.to}>{section.title}</Link>
            </h3>
            <p className="muted">{section.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
