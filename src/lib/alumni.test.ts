import { describe, expect, it } from 'vitest';
import { alumniKey, buildAlumniRow, fieldForHeader, findHeaderRow, isSensitiveHeader, tenureYears, toIsoDate } from './alumni';

describe('alumni headers', () => {
	it('reads the master tracker headers and the usual exit columns', () => {
		expect(fieldForHeader('Emp Code')).toBe('employeeCode');
		expect(fieldForHeader('CIPL Emp Code')).toBe('employeeCode');
		expect(fieldForHeader('Name Of the Employee')).toBe('fullName');
		expect(fieldForHeader('Official E Mail ')).toBe('officialEmail');
		expect(fieldForHeader('Sub Process / Department')).toBe('department');
		expect(fieldForHeader('Nature of Exit')).toBe('natureOfExit');
		expect(fieldForHeader('LWD')).toBe('lastWorkingDay');
		expect(fieldForHeader('Date of Leaving')).toBe('lastWorkingDay');
		expect(fieldForHeader('Relieving Date')).toBe('lastWorkingDay');
		expect(fieldForHeader('F&F Status')).toBe('fnfStatus');
		expect(fieldForHeader('Father Name')).toBeNull();
	});

	it('never keeps ID or bank columns', () => {
		for (const h of ['Aadhar Number', 'PAN No', 'UAN Number', 'DL #', 'Voters ID #', 'Passport No', 'Bank-IFSC code', 'Salary Bank Account #', 'Personal Bank Account #']) {
			expect(isSensitiveHeader(h), h).toBe(true);
		}
		for (const h of ['Company', 'Designation', 'Team', 'Reason']) expect(isSensitiveHeader(h), h).toBe(false);
	});

	it('finds the header row below a title row', () => {
		const rows = [['Left employees 2026'], [], ['Sl.No', 'Emp Code', 'Name Of the Employee', 'Date of Leaving'], ['1', 'C1', 'Asha', '2026-01-05']];
		expect(findHeaderRow(rows).index).toBe(2);
	});
});

describe('alumni dates', () => {
	it('reads the forms HR sheets use, day first', () => {
		expect(toIsoDate(new Date(Date.UTC(2026, 2, 12)))).toBe('2026-03-12');
		expect(toIsoDate(46093)).toBe('2026-03-12');
		expect(toIsoDate('2026-03-12')).toBe('2026-03-12');
		expect(toIsoDate('12/03/2026')).toBe('2026-03-12');
		expect(toIsoDate('12-03-2026')).toBe('2026-03-12');
		expect(toIsoDate('12.03.2026')).toBe('2026-03-12');
		expect(toIsoDate('12-Mar-2026')).toBe('2026-03-12');
		expect(toIsoDate('12 March 2026')).toBe('2026-03-12');
		expect(toIsoDate("12th Mar'26")).toBe('2026-03-12');
		expect(toIsoDate('March 12, 2026')).toBe('2026-03-12');
	});

	it('refuses what is not a date', () => {
		expect(toIsoDate('31/02/2026')).toBeNull();
		expect(toIsoDate('NA')).toBeNull();
		expect(toIsoDate('soon')).toBeNull();
		expect(toIsoDate(12)).toBeNull();
	});
});

describe('alumni rows', () => {
	const headers = ['Sl.No', 'Emp Code', 'Name Of the Employee', 'Official E Mail', 'Date of Joining', 'Date of Leaving', 'Nature of Exit', 'Aadhar Number', 'DOB', 'DOB', 'Remarks'];

	it('maps known columns, keeps the rest verbatim and drops ID numbers', () => {
		const r = buildAlumniRow(headers, ['1', ' cipl 0042 ', 'Asha  Rao', 'Asha.Rao@Example.com', '01/06/2022', '15-Mar-2026', 'Resigned', '1234 5678 9012', '1990-01-01', '1991-02-02', 'NA'])!;
		expect(r.employeeCode).toBe('CIPL0042');
		expect(r.fullName).toBe('Asha Rao');
		expect(r.officialEmail).toBe('asha.rao@example.com');
		expect(r.dateOfJoining).toBe('2022-06-01');
		expect(r.lastWorkingDay).toBe('2026-03-15');
		expect(r.natureOfExit).toBe('Resigned');
		expect(r.remarks).toBeNull();
		expect(r.details).toEqual({ 'Sl.No': '1', DOB: '1990-01-01', 'DOB (2)': '1991-02-02' });
		expect(JSON.stringify(r)).not.toContain('5678');
	});

	it('skips rows with no name', () => {
		expect(buildAlumniRow(headers, ['', '', '', '', '', '', ''])).toBeNull();
		expect(buildAlumniRow(headers, ['Total', '', '42'])).toBeNull();
	});

	it('keys a person by code, else by name and leaving date', () => {
		expect(alumniKey({ employeeCode: 'C1', fullName: 'Asha', lastWorkingDay: null, dateOfJoining: null })).toBe('code:C1');
		expect(alumniKey({ employeeCode: null, fullName: ' Asha  Rao ', lastWorkingDay: '2026-03-15', dateOfJoining: null })).toBe('name:asha rao|2026-03-15');
	});

	it('works out tenure in years', () => {
		expect(tenureYears('2022-06-01', '2026-03-15')).toBe(3.8);
		expect(tenureYears(null, '2026-03-15')).toBeNull();
		expect(tenureYears('2026-03-15', '2022-06-01')).toBeNull();
	});
});
