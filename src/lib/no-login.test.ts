import { describe, expect, it } from 'vitest';
import { isNoLoginEmail, noLoginEmail } from './no-login';

describe('no-login placeholder addresses', () => {
	it('builds one from the employee code, else the name', () => {
		expect(noLoginEmail('INFRATECH0212', 'Ramadass')).toBe('infratech0212@no-login.invalid');
		expect(noLoginEmail(null, 'Redd Palli Narasimha Reddy')).toBe('redd.palli.narasimha.reddy@no-login.invalid');
		expect(noLoginEmail('  ', 'Naveenkumar N.N')).toBe('naveenkumar.n.n@no-login.invalid');
	});

	it('recognises only its own placeholders', () => {
		expect(isNoLoginEmail('infratech0212@no-login.invalid')).toBe(true);
		expect(isNoLoginEmail(' INFRATECH0212@NO-LOGIN.INVALID ')).toBe(true);
		expect(isNoLoginEmail('suresh.k@championsmail.com')).toBe(false);
		expect(isNoLoginEmail('someone@invalid')).toBe(false);
		expect(isNoLoginEmail(null)).toBe(false);
	});
});
