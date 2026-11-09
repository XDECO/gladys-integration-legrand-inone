# Legrand In One CPL

Unofficial integration, not affiliated with Legrand. It turns on and off the lights of a Legrand In One (powerline, "CPL") installation from Gladys, and shows their state when someone presses a wall switch.

## What you need

- A Legrand USB / RS232 interface, reference 882 13, plugged into the machine that runs Gladys.
- A small "serial gateway" container that exposes this USB device on a TCP port. Gladys integrations cannot access USB devices directly, so this container does it for them (see the project README for a ready-to-use `docker-compose.yml`).

## Setup

1. Start the serial gateway container. By default it listens on `172.17.0.1:2000`.
2. Install this integration and check the address and port in its settings.
3. **Press each wall switch once.** The Legrand bus cannot list its devices, so the integration learns each circuit from the frames the switches send when they are pressed.
4. Open the Discovery tab and run a scan. Each circuit seen on the bus appears as a light named `Legrand <id>-<unit>`. Create the ones you want and rename them.

If a switch does not appear, press it again and rescan. The list of known circuits is kept across restarts.

## What it does

- Turns lights on and off from Gladys (dashboard, scenes, voice).
- Updates the state in Gladys when a wall switch is used.
- Shows each Legrand scenario button as a button in Gladys (`Legrand scenario <id>-<unit>`). It clicks when the scenario is pressed, so you can use it as a trigger in Gladys scenes.

## Push buttons that toggle

Some wall buttons send the same "on" frame every time they are pressed, while the receiver switches on and off alternately. The bus does not tell the real state, so list these circuits in the setting **Toggle push buttons**, using the numbers seen in the logs (for example `10383457, 15112946`). Each press then flips the state shown in Gladys.

## Limits of this version

- The bus never reports the real state of a receiver. The state shown in Gladys is deduced from the frames and from the commands sent, so it can drift (for example after a Legrand scenario that switches lights off). A command from Gladys always puts it back in line.
- To keep Gladys up to date after a Legrand scenario, create a Gladys scene triggered by the scenario button that sets the concerned lights to their new state.
- On/off lights only: no dimmers, no shutters, and Gladys cannot start a Legrand scenario.
