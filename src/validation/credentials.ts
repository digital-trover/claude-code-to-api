import { assertObject, assertString } from './assert.js';

export function validateVerifyRequest(body: unknown): { token: string } {
  const req = assertObject(body, 'body');
  return { token: assertString(req.token, 'token') };
}
