// React Native/Hermes provides performance.now(), but RN's default TypeScript
// configuration excludes DOM globals. Declare only the clock surface we use.
declare const performance: { now(): number };
