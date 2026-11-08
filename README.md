# Legrand In One CPL — Gladys Assistant integration (work in progress)

Unofficial external integration for [Gladys Assistant](https://gladysassistant.com) to control
Legrand **In One by Legrand** (PLC / CPL) lights through the Legrand **882 13** USB interface.
Formerly known as *Boxio* in the Jeedom community.

> Not affiliated with Legrand. Status: **phase 2 of 6** (protocol library and TCP transport, not installable yet).

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Feasibility proofs on real hardware | done |
| 1 | Protocol library and tests (`src/protocol.js`) | done |
| 2 | TCP transport (`src/transport.js`: reconnection, paced send) | done |
| 3 | Gladys layer (manifest, discovery, commands, states) | todo |
| 4 | Docker image and CI | todo |
| 5 | Acceptance tests on the real installation | todo |
| 6 | Publication | todo |

## Protocol, as verified on hardware

- Frame: `*WHO*WHAT*WHERE##`. WHO `1` = light (WHAT `1` on, `0` off), WHO `25` = scenario (WHAT `11` press, `16` release).
- Address = `legrandId * 16 + unit` (unit 0..15).
- Received frames are broadcasts: `*1*1*0#<address>##`.
- To drive a light, send `*1*1*#<address>##` (on) or `*1*0*#<address>##` (off).
  The plain form (`*1*1*<address>##`) and the broadcast form did not work.

## Development

```bash
npm test      # Node.js >= 20, no dependency
```

## License

Apache-2.0, see `LICENSE` and `NOTICE`. Copyright 2026 XDECO.
