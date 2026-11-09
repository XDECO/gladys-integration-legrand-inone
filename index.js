/**
 * Entry point of the integration container.
 * No logic here: it only creates the real objects and plugs them together.
 * The SDK reads GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and
 * GLADYS_INTEGRATION_SELECTOR from the environment.
 */

import path from 'node:path';
import {
  GladysIntegration,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  logger,
} from '@gladysassistant/integration-sdk';
import { CircuitRegistry } from './src/circuits.js';
import { JsonStorage } from './src/storage.js';
import { LegrandGateway } from './src/transport.js';
import { LegrandIntegration } from './src/integration.js';

const DATA_DIR = process.env.DATA_DIR || '/data';

const gladys = new GladysIntegration();

const integration = new LegrandIntegration({
  gladys,
  createGateway: ({ host, port }) => new LegrandGateway({ host, port, logger }),
  registry: new CircuitRegistry(),
  storage: new JsonStorage(path.join(DATA_DIR, 'circuits.json')),
  constants: {
    light: {
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
    },
    scenario: {
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.CLICK,
    },
  },
  logger,
});

// Handlers first, then the connection.
integration.attach();
gladys.handleShutdown(() => integration.stop());

await gladys.connect();
await integration.start();
logger.info('Legrand In One CPL integration started');
