import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

type Config = { android?: Record<string, unknown>; extra?: Record<string, unknown> };
const appConfig = createRequire(import.meta.url)('../app.config.js') as (input: { config: Config }) => Config;
const base: Config = { android: { package: 'dev.sakuga.boo' }, extra: { relayUrl: 'https://relay.test' } };

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  try {
    run();
  } finally {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

test('GOOGLE_SERVICES_JSON gives Android the Firebase file of the push token, and nothing else changes without it', () => {
  withEnv({ GOOGLE_SERVICES_JSON: '/tmp/eas/google-services.json' }, () => {
    assert.deepEqual(appConfig({ config: base }).android, {
      package: 'dev.sakuga.boo',
      googleServicesFile: '/tmp/eas/google-services.json',
    });
  });
  withEnv({ GOOGLE_SERVICES_JSON: undefined, BOO_EXPO_PUSH_URL: undefined }, () => {
    const config = appConfig({ config: base });
    assert.deepEqual(config.android, base.android);
    assert.deepEqual(config.extra, base.extra);
  });
});

test('BOO_EXPO_PUSH_URL gives the fake Expo of a local demo', () => {
  withEnv({ BOO_EXPO_PUSH_URL: 'http://localhost:4652' }, () => {
    assert.equal(appConfig({ config: base }).extra?.expoPushUrl, 'http://localhost:4652');
  });
});
