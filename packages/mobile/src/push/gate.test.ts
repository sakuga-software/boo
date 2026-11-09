import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registrationGate } from './gate';

test('a run holds the gate until it ends', () => {
  const gate = registrationGate();
  assert.equal(gate.running, false);
  const run = gate.start();
  assert.equal(gate.running, true);
  gate.end(run);
  assert.equal(gate.running, false);
});

test('the late end of a replaced run does not free the gate of the run after it (#710d10)', () => {
  const gate = registrationGate();
  const first = gate.start();
  // A new session or a new attempt starts a second run before the first one ends.
  const second = gate.start();
  gate.end(first);
  assert.equal(gate.running, true, 'the second run still holds the gate');
  gate.end(second);
  assert.equal(gate.running, false);
});
