import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One single-node replica set for the whole run (transactions need a replica set). Each test
 * file gets its own database on it. Set MONGOMS_SYSTEM_BINARY to use a local mongod.
 */
export default async function setup(project: TestProject) {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    ...(process.env.MONGOMS_SYSTEM_BINARY
      ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } }
      : {}),
  });
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet.stop();
  };
}
