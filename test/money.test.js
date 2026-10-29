import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementAmount } from '../src/money.js';

test('settlementAmount keeps USD when no settlement currency is set', () => {
  assert.deepEqual(settlementAmount(3800, undefined), { currency: 'USD', value: '38.00' });
  assert.deepEqual(settlementAmount(3800, { currency: '', fxRate: 0 }), { currency: 'USD', value: '38.00' });
});

test('settlementAmount converts to a zero-decimal currency in whole units (HUF-primary sandbox merchant)', () => {
  assert.deepEqual(settlementAmount(3800, { currency: 'HUF', fxRate: 316.095975 }), { currency: 'HUF', value: '12012' });
});

test('settlementAmount keeps two decimals for EUR', () => {
  assert.deepEqual(settlementAmount(3800, { currency: 'EUR', fxRate: 0.92 }), { currency: 'EUR', value: '34.96' });
});

test('settlementAmount refuses to guess a missing rate', () => {
  assert.throws(() => settlementAmount(3800, { currency: 'HUF', fxRate: 0 }), /No FX rate/);
});
