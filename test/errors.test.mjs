// Friendly error messages: raw API failures become plain English. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { friendlyError } from '../public/errors.js';

const tfl404 = 'api.tfl.gov.uk returned 404: {"$type":"Tfl.Api.Presentation.Entities.ApiError, Tfl.Api.Presentation.Entities","timestampUtc":"2026-10-17T09:34:17Z","exceptionType":"EntityNotFoundException","httpStatusCode":404}';

test('TfL 404 says no route was found, without the raw JSON', () => {
  assert.equal(friendlyError(tfl404), "TfL couldn't find a route from here.");
});

test('busy, broken and slow services are named in plain English', () => {
  assert.equal(friendlyError('data.police.uk returned 429'), 'The police crime service is busy right now. Try again in a minute.');
  assert.equal(friendlyError('api.postcodes.io returned 503'), 'The postcode service is having problems right now. Try again later.');
  assert.equal(friendlyError('landregistry.data.gov.uk timed out'), 'Land Registry took too long to answer. Try again.');
  assert.equal(friendlyError('api.get-energy-performance-data.communities.gov.uk returned 400: bad'), "The energy certificate service didn't accept the request.");
});

test('connection failures say where the problem is', () => {
  assert.equal(friendlyError('fetch failed'), "Couldn't connect to the data services. Check the Mac's internet connection.");
  assert.equal(friendlyError('Load failed'), "Couldn't reach Doorstep. Check the app is still running on the Mac.");
  assert.equal(friendlyError('Failed to fetch'), "Couldn't reach Doorstep. Check the app is still running on the Mac.");
});

test("Doorstep's own short messages pass through; long unknown ones don't", () => {
  assert.equal(friendlyError("Couldn't find that postcode"), "Couldn't find that postcode");
  assert.equal(friendlyError(new Error('No schools file. Run npm run setup.')), 'No schools file. Run npm run setup.');
  assert.equal(friendlyError('x'.repeat(200)), 'Something went wrong. Try again in a minute.');
  assert.equal(friendlyError('Request failed (502)'), 'Something went wrong. Try again in a minute.');
  assert.equal(friendlyError(''), 'Something went wrong. Try again in a minute.');
});
