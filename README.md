# Legrand In One CPL — Gladys Assistant integration (work in progress)

Unofficial external integration for [Gladys Assistant](https://gladysassistant.com) to control
Legrand **In One by Legrand** (PLC / CPL) lights through the Legrand **882 13** USB interface.
Formerly known as *Boxio* in the Jeedom community.

> Not affiliated with Legrand. Status: **phase 4 of 6** (code, Docker image and CI ready; not released yet).

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Feasibility proofs on real hardware | done |
| 1 | Protocol library and tests (`src/protocol.js`) | done |
| 2 | TCP transport (`src/transport.js`: reconnection, paced send) | done |
| 3 | Gladys layer (manifest, docs, discovery, commands, states) | done |
| 4 | Docker image and CI (`Dockerfile`, `.github/workflows`) | done |
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

## Serial gateway (required)

Gladys integrations run in a sandbox and cannot open a USB device. A small container exposes the 882 13 on a TCP port that the integration then connects to:

```yaml
services:
  legrand-serial:
    image: alpine/socat
    container_name: legrand-serial
    restart: always
    labels:
      - com.centurylinklabs.watchtower.enable=false
    devices:
      - /dev/serial/by-id/<your-882-13>:/dev/legrand
    ports:
      - "172.17.0.1:2000:2000"
    command: tcp-listen:2000,fork,reuseaddr,max-children=1 /dev/legrand,raw,echo=0,b115200,hupcl=0
```

## How circuits are found

The Legrand bus cannot list its devices. The integration learns a circuit when a wall switch is pressed, saves it in `/data/circuits.json`, and offers it at the next scan.

## Development

```
npm install
npm test
```
