# Managed static websites

Related tracking: [#125](https://github.com/petauron/catalog/issues/125).

These recipes use the same official Caddy 2.11.4 release as the managed gateway,
with separate immutable amd64/arm64 archive digests and an exact extraction
allowlist. They introduce no container, shell hook, database, upload endpoint,
reverse proxy or new library dependency. Publishing the catalog does not install
an application. An Agent supporting systemd runtime v2 is required.

## Choose the installation

- `static-site`: a private HTTP origin, published using a normal Vastora web
  publication and its managed gateway. Use this when HAProxy/Caddy already owns
  public ports. The application must never replace their configuration.
- `static-site-https`: a private HTTP origin plus its own public HTTPS listener.
  Use only on a host with a free public TCP 443, including an IPv6-only host that
  the current generic IPv4 publication flow cannot represent. This is an
  application-owned listener, not new generic IPv6 publication support. Do not
  create a second gateway publication for it. DNS and any provider firewall
  must allow direct TCP 443 access.

Both run as a dedicated managed nonroot user. Only the direct HTTPS recipe grants
`CAP_NET_BIND_SERVICE`; it does not request root, NET_ADMIN or host filesystem
access. The existing executor sandbox restricts writes to application-owned
state. Per instance: 128 MiB hard memory limit, 64 MiB Go soft memory target,
50% of one CPU and 64 tasks. These are service limits, not a guarantee of unused
host capacity; check capacity before installation.

## Inputs and exposure

`hostname` is one owned exact DNS name, such as `hk.example.com`. Do not enter a
wildcard, URL, port or path. `html` is a self-contained page at `/`, with inline
CSS and optional inline images. The content security policy blocks scripts,
forms, frames and external resources. Use anchors within the page, not links to
unprovided local files. Configuration is administrator-owned; never embed
credentials or private operational data. Non-root paths and other Host values
receive 404. `/healthz` is a private HTTP readiness check, not TLS acceptance.

`http_port` defaults to 24480 and binds the Agent's private service address.
Choose a free high port if another application uses it. For `static-site`, create
an HTTPS web publication with the same hostname and TLS enabled through the
existing managed gateway. For `static-site-https`, also set `https_listen` to an
unused local address and port 443, for example `[2001:db8::10]:443`. Check the
actual listener and firewall first; never displace an existing listener.

The direct recipe serves HTTP/1.1 and HTTP/2 over TLS 1.3. TLS requires the exact
SNI and matching HTTP Host. Its final TLS connection policy drops unknown or
missing SNI. Caddy's pinned `drop` policy is upstream experimental; review it
before advancing the Caddy release. No UDP/HTTP3 listener or HTTP redirect on
port 80 is created. Automatic Let's Encrypt issuance/renewal uses TLS-ALPN-01
on TCP 443, with HTTP-01 disabled. Point DNS A/AAAA directly to the server before
expecting a certificate; a CDN proxy will break this challenge. No DNS API token
is installed on the node. Certificate names are public and can appear in CT.

The private origin and direct listener serve the same configured page. The
Center's private homepage does not bypass hostname matching: use the published
hostname for the public page. Updates/restarts retain Caddy certificate/account
state, so do not purge it during ordinary updates. Caddy's administration API is
disabled; Vastora owns the unit, executable, generated configuration and lifecycle.

## Deployment and rollback

Record each installation, DNS record ID and publication created by this change.
Existing services need no database snapshot for adding an independent app.
Preserve their configuration and listeners; no direct edits to managed Caddy,
HAProxy, Xray or firewall chains. Review the normal publication plan before
applying it. Stop if it would replace an existing public endpoint or disrupt an
unrelated service without authorization.

After installation verify DNS, the actual public HTTPS page, certificate chain,
TLS 1.3 and H2, exact SNI/Host behavior and existing entry services. An installed
or healthy state alone does not establish public HTTPS readiness. For rollback,
remove only the new publication/DNS records, then uninstall the new app through
Vastora while retaining its persistent state until recovery is no longer needed.
Do not delete shared gateway resources or another application's data.

Deploying a website does not change REALITY targets or SNIs. In particular, never
point a REALITY fallback at the same shared public address/SNI that HAProxy sends
back to that REALITY listener: that creates a routing loop. Evaluate the actual
entry-to-target path separately before any proxy configuration change.
