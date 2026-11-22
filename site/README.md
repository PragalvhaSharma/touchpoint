# Touchpoint landing page

`site/index.html` is a single self-contained page (only Google Fonts load from outside). There is no build step.

## Preview locally

```sh
open site/index.html
# or
python3 -m http.server 4000 --directory site
```

## Deploy to Vercel

From the repo root:

```sh
vercel deploy site --prod
```

The first run asks you to link or create a Vercel project. Keep the default settings: no framework, no build command, output directory `.`.

## Attach the domain

1. Add the domain to the project:

   ```sh
   vercel domains add <domain>
   ```

   Run it from inside `site/` (or pass the project name) so it attaches to the right project.

2. At the registrar where the domain was registered, set DNS to point at Vercel:

   | Host | Type | Value |
   | --- | --- | --- |
   | `@` (apex, e.g. `example.us`) | A | `76.76.21.21` |
   | `www` | CNAME | `cname.vercel-dns.com` |

   Or switch the domain's nameservers to Vercel's if you prefer Vercel to manage DNS.

3. Check it with `vercel domains inspect <domain>`. Vercel issues the HTTPS certificate on its own once DNS resolves, usually within a few minutes.

## Getting the free domain (MLH x GoDaddy Registry)

Hack Western 13 attendees can register one domain free for 12 months at https://tech.study (MLH's link https://mlh.link/godaddyregistry redirects there). Search for a name, pick an available one, click **Get It**, and enter the event promo code from the MLH email. Eligible extensions: .us, .biz, .tv, .courses, .study, .club, .design, .compare, .select and .co. Claim by Nov 26, 2026. Renewal after the first year is at the registrar's normal price.
