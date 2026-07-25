# when.org DNS snapshot, before Pages cutover (2026-07-24)

Rollback insurance. Captured from the Cloudflare API immediately before
attaching when.org / www.when.org to the `when-org` Cloudflare Pages project.
Zone id: `a44d2e46816a1163653079689227b335` (account `tedbarnett`,
`e164cdeb684cb596b09098f2a1416adc`).

All records were DNS-only (not proxied), TTL 3600.

## A records (apex, when.org) -> Squarespace

| Type | Name     | Content         |
|------|----------|-----------------|
| A    | when.org | 198.185.159.145 |
| A    | when.org | 198.185.159.144 |
| A    | when.org | 198.49.23.145   |
| A    | when.org | 198.49.23.144   |

## CNAME

| Type  | Name         | Content                  |
|-------|--------------|--------------------------|
| CNAME | www.when.org | ext-cust.squarespace.com |

## MX records (Google Workspace mail) - NOT TOUCHED in the cutover

| Type | Name     | Priority | Content                 |
|------|----------|----------|-------------------------|
| MX   | when.org | 1        | aspmx.l.google.com      |
| MX   | when.org | 5        | alt1.aspmx.l.google.com |
| MX   | when.org | 10       | alt2.aspmx.l.google.com |
| MX   | when.org | 10       | alt3.aspmx.l.google.com |
| MX   | when.org | 10       | alt4.aspmx.l.google.com |

## Rollback

To restore the Squarespace site:

1. Remove custom domains `when.org` and `www.when.org` from the
   `when-org` Pages project (Cloudflare dashboard -> Workers & Pages ->
   when-org -> Custom domains).
2. Delete the Pages-created apex/www records for when.org.
3. Recreate the four A records and the www CNAME exactly as listed above
   (DNS only, TTL 3600).

MX records were never modified, so mail is unaffected either way.
