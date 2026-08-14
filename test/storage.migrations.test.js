import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations, MIGRATIONS } from '../dist/storage/migrations/index.js';

class MockQueryable {
    constructor() {
        this.rows = [];
        this.queries = [];
    }

    async query(sql, params) {
        this.queries.push(sql);
        if (sql.includes('SELECT version FROM schema_migrations')) {
            return { rows: this.rows };
        }
        if (sql.includes('INSERT INTO schema_migrations')) {
            if (params) {
                this.rows.push({
                    version: params[0],
                    name: params[1],
                    applied_at: params[2]
                });
            }
            return { rows: [] };
        }
        return { rows: [] };
    }
}

test('runMigrations applies all pending migrations in order', async () => {
    const mockDb = new MockQueryable();
    const count = await runMigrations(mockDb, { log: () => {} });

    assert.equal(count, MIGRATIONS.length);
    assert.equal(mockDb.rows.length, MIGRATIONS.length);
    assert.equal(mockDb.rows[0].version, 1);
});

test('runMigrations is idempotent when migrations are already applied', async () => {
    const mockDb = new MockQueryable();
    await runMigrations(mockDb, { log: () => {} });
    const countSecond = await runMigrations(mockDb, { log: () => {} });

    assert.equal(countSecond, 0);
});
