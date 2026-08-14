import type { AppConfig } from '../config.js';
import type { IStorageBackend } from './types.js';
import { FileStorageBackend } from './file/index.js';
import { PostgresStorageBackend } from './postgres/index.js';

export * from './types.js';
export * from './migrations/index.js';
export * from './importer.js';
export { FileStorageBackend } from './file/index.js';
export { PostgresStorageBackend } from './postgres/index.js';

export function createStorageBackend(cfg: AppConfig): IStorageBackend {
    if (cfg.store === 'postgres' || (cfg.store as string) === 'postgresql') {
        return new PostgresStorageBackend(cfg);
    }
    return new FileStorageBackend(cfg.dataFile);
}
