# mDNS fixtures

Real replies to a `_googlecast._tcp.local` PTR query, captured on a home network on 2026-11-24 and sanitized with
same-length replacements so the packets stay valid: device ids, certificate ids (`cd`), `bs`, `rm`, `ct`, friendly
names, host names and addresses were replaced. IPv4 addresses are `10.0.0.x`; IPv6 addresses are `fd00::x`.

| File | Source device | Notes |
|---|---|---|
| `chromecast.hex` | Chromecast (Android-based firmware) | Legacy unicast reply: echoes the question; no cache-flush bits. |
| `home-mini.hex` | Google Home Mini | Audio-only (`ca` has no video bit). |
| `fuchsia-hub-max-groups.hex` | Nest Hub Max (Fuchsia) | No question section; three PTRs in one packet (the hub plus two speaker groups it leads on ports 32044 and 32200); cache-flush class `0x8001`; one A and four AAAA records with mixed cache-flush bits. Group ids are dashed UUIDs. |
