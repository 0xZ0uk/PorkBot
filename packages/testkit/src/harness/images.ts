/**
 * The container images the testkit runs, pinned by digest.
 *
 * A tag is a moving target: `postgres:18` is whatever the registry served the
 * day the tier ran, which makes a red integration result impossible to
 * reproduce from the repository alone. The digest names the exact image the
 * tier was proven against. `dependencies.json` records the same reference, and
 * the `dependencies` CI tier fails when the two drift, so the pin cannot be
 * updated in one place and forgotten in the other.
 */

/** Production runs Postgres 18 (PRD stack decision 11). One number, one place. */
export const productionPostgresMajor = 18;

/** The multi-platform index digest for `postgres:18` (Postgres 18.6). */
export const postgresImageDigest =
  "sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";

export const postgresImage = `postgres:${productionPostgresMajor}@${postgresImageDigest}`;

/**
 * The reverse proxy the deployment ships (slice 12.2). The integration suite
 * boots this exact image with `deploy/Caddyfile`, so the config the operator
 * runs is the config the suite drives.
 */
export const caddyImage =
  "caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e";
