# Security

ModelDock handles local API keys, OAuth credentials and client configuration.
Use the latest release. Fixes target the latest source and release; older
versions do not have a separately maintained security branch.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** private reporting
channel when it is enabled. Do not publish credentials, exploit-ready details,
private client databases or a full account/profile dump in a public issue.
If private reporting is unavailable, open a minimal public issue asking the
maintainers for a private reporting channel, without sensitive details.

Include the affected version, platform, reproducible steps using synthetic
credentials and the expected security boundary. Redact identifiers and secret
values; provide only the smallest metadata needed to reproduce the problem.
Coordinate publication with maintainers while a fix is prepared.

## Boundaries contributors must preserve

- Keep the gateway and any native client interfaces on loopback. A public OAuth
  client identifier is not a secret and is not proof of an official partnership.
- Keep credentials in the main process. Renderer snapshots, previews, logs and
  exported diagnostics must not include tokens or conversation bodies.
- Do not trust a local port, profile file or process name as proof of a client
  application's identity. Fail safely when a supported identity cannot be verified.
- Validate paths and upstream URLs, reject unsafe redirects and links, and avoid
  replacing another program's concurrent configuration changes.
- Use isolated temporary profiles and mock upstreams for automated checks. Never
  import a contributor's actual account files or change startup settings in CI.

Required third-party copyright and license notices are public attribution;
preserve them when removing private data. Notify maintainers privately if a real
credential was ever committed, and revoke it before planning history cleanup.
