import { open } from '@op-engineering/op-sqlite';
import { Platform } from 'react-native';
import { createRepository } from './repository';
import type { SqlDatabase } from './types';

// Open lazily so startup failures reach the UI's retry/error flow.
let database: ReturnType<typeof open> | undefined;
const adapter: SqlDatabase = {
  async execute(sql, params) {
    database ??= open({ name: 'capstone.sqlite' });
    const result = await database.execute(sql, params);
    return { rows: result.rows };
  },
};
export const measurementStore = createRepository(adapter, Platform.OS);
