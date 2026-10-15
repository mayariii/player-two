import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from './cart.mjs';
test('empty cart costs zero', () => assert.equal(cartTotal([]), 0));
test('quantity is included in the total', () => assert.equal(cartTotal([{ priceCents: 250, quantity: 2 }, { priceCents: 150, quantity: 1 }]), 650));
test('zero quantity contributes nothing', () => assert.equal(cartTotal([{ priceCents: 250, quantity: 0 }]), 0));
