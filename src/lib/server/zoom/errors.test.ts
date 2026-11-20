import { describe, expect, it } from 'vitest';
import { isScopeError, missingScopes } from './errors';

const zoom4711 = '{"code":4711,"message":"Invalid access token, does not contain scopes:[meeting:write:meeting, meeting:write:meeting:admin]."}';

describe('Zoom scope errors', () => {
	it('recognises a missing-scope reply by its code or its words', () => {
		expect(isScopeError(zoom4711)).toBe(true);
		expect(isScopeError('{"code": 4711}')).toBe(true);
		expect(isScopeError('Invalid access token, does not contain scopes:[x]')).toBe(true);
	});

	it('does not mistake other failures for one', () => {
		expect(isScopeError('{"code":1001,"message":"User does not exist"}')).toBe(false);
		expect(isScopeError('{"code":47110}')).toBe(false);
		expect(isScopeError('')).toBe(false);
	});

	it('lists the scopes Zoom names', () => {
		expect(missingScopes(`Zoom POST /users/x/meetings answered 400: ${zoom4711}`)).toEqual(['meeting:write:meeting', 'meeting:write:meeting:admin']);
		expect(missingScopes('does not contain scopes:[meeting:read:summary:admin]')).toEqual(['meeting:read:summary:admin']);
		expect(missingScopes('something else')).toEqual([]);
	});
});
