/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe' });
    logger.debug('Docker is running');
  } catch {
    logger.error('Docker is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                     ║',
    );
    console.error(
      '║  1. Ensure Docker Desktop is installed and running             ║',
    );
    console.error(
      '║  2. Start Docker Desktop                                       ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter "name=nanoclaw-" --format "{{.Names}}\t{{.Status}}"`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );

    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line);
    const orphans: string[] = [];

    for (const line of lines) {
      const [name, status] = line.split('\t');
      if (name && status && status.startsWith('Up')) {
        orphans.push(name);
      }
    }

    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
