import test from 'node:test';
import assert from 'node:assert/strict';
import { toWebhookPayload, buildQuery } from '../src/index.js';

test('maps a lead to the webhook schema', () => {
  const p = toWebhookPayload(
    {
      id: '123',
      leadType: 'PHONE_CALL',
      leadStatus: 'NEW',
      creationDateTime: '2026-10-07 10:00:00',
      contactDetails: { consumerName: 'Jane Q Public', phoneNumber: '+15551234567', email: 'j@x.com' },
      note: { description: 'Needs a quote' },
    },
    'Acme',
  );
  assert.equal(p.firstName, 'Jane');
  assert.equal(p.lastName, 'Q Public');
  assert.equal(p.phone, '+15551234567');
  assert.equal(p.companyName, 'Acme');
  assert.match(p.notes, /Needs a quote/);
  for (const k of ['phone','email','firstName','lastName','companyName','address','city','state','postalCode','notes'])
    assert.equal(typeof p[k], 'string');
});

test('handles missing contact details', () => {
  const p = toWebhookPayload({ id: '1' });
  assert.equal(p.phone, '');
  assert.equal(p.firstName, 'Potential');
  assert.equal(p.lastName, 'Customer');
});

test('query filters by creation time', () => {
  assert.match(buildQuery(new Date('2026-10-07T10:00:00Z')), /creation_date_time >= '2026-10-07 10:00:00'/);
});
