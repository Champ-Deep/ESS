import { describe, test, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseHrTeamSheet, suggestReportsToIndex, type ParsedImportRow } from './bulk-import';

/**
 * These cover the tracker's misaligned rows, where a value sits under a header
 * that does not describe it. The repair pass rebuilds such blocks by value
 * shape, and the cases below are the ones that were getting it wrong: a UAN
 * copied into the licence field, and a bachelor's degree filed as a master's.
 */

const HEADERS = [
	'Name Of the Champion',
	'Official E Mail ',
	'Total Experience in Years',
	'Aadhar Number',
	'PAN No',
	'UAN Number',
	'DL #',
	'Under Graduate',
	'Graduate',
	'Masters'
];

/**
 * The tracker's bank region: a personal block followed by a repeated salary
 * block. A drifted row places its four values anywhere across the span.
 */
const BANK_HEADERS = [
	'Name Of the Champion',
	'Official E Mail ',
	'Personal Bank Account #',
	'Employee Name as Per Bank ',
	'Bank Name',
	'Bank-IFSC code',
	'Salary Bank Account #',
	'Bank',
	'Bank-IFSC code',
	'Salary Bank Account #'
];

async function parseBankRow(cells: (string | number | null)[]): Promise<ParsedImportRow> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('HR Team Master Tracker');
	sheet.addRow(BANK_HEADERS);
	sheet.addRow(cells);
	const buffer = await workbook.xlsx.writeBuffer();
	const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
	return result.rows[0];
}

/** Builds a one-row workbook with the tracker's header names. */
async function parseRow(cells: (string | number | null)[]): Promise<ParsedImportRow> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('HR Team Master Tracker');
	sheet.addRow(HEADERS);
	sheet.addRow(cells);
	const buffer = await workbook.xlsx.writeBuffer();
	const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
	return result.rows[0];
}

describe('government ID repair', () => {
	test('a UAN is not also copied into the licence field', async () => {
		// The drifted block leaves no Aadhaar, so the single 12-digit value is the
		// UAN. Matching claims by value rather than by position left that same
		// value looking unclaimed, and it was written to the licence field too.
		const row = await parseRow([
			'Test Person', 't@example.com',
			'2.8 yrs', '249293242615', 'FKJPP9632R', '101558316456', '101558316456',
			null, null, null
		]);
		expect(row.uanNumber).toBe('101558316456');
		expect(row.drivingLicenseNumber).toBeNull();
	});

	test('a bare number is never recorded as a licence', async () => {
		// "14.5" is years of service that drifted into the licence column.
		const row = await parseRow([
			'Test Person', 't@example.com',
			null, '822488521019', 'ABCPP1234X', null, '14.5',
			null, null, null
		]);
		expect(row.drivingLicenseNumber).toBeNull();
	});

	test('a genuine licence survives the rebuild', async () => {
		const row = await parseRow([
			'Test Person', 't@example.com',
			'3.5 yrs', '249293242615', 'FKJPP9632R', '101558316456', 'KA5120170071762',
			null, null, null
		]);
		expect(row.drivingLicenseNumber).toBe('KA5120170071762');
		expect(row.aadharNumber).toBe('249293242615');
		expect(row.uanNumber).toBe('101558316456');
	});
});

describe('header-driven parsing', () => {
	/**
	 * The repair pass exists for the tracker's misaligned rows. It must never be
	 * what a correctly-labelled sheet depends on: when every value sits under its
	 * true header, the headers alone have to produce the whole row, and the
	 * repair pass has to leave it alone.
	 */
	test('a correctly aligned sheet parses from headers, untouched by repair', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow([
			'CIPL Emp Code', 'Name Of the Champion', 'Designation', 'Gender',
			'Contact Number', 'Personal E Mail', 'Official E Mail ',
			'Under Graduate', 'Graduate', 'Masters', 'Total Experience in Years',
			'Aadhar Number', 'PAN No', 'UAN Number', 'DL #',
			'Personal Bank Account #', 'Employee Name as Per Bank ', 'Bank Name', 'Bank-IFSC code',
			'Contact Name in case of Emergency', 'Contact Number'
		]);
		sheet.addRow([
			'CIPL9001', 'Clean Person', 'Analyst', 'Female',
			'9876543210', 'clean@gmail.com', 'clean@championsmail.com',
			'SSLC', 'BCom', 'MBA', '5 yrs',
			'123456789012', 'ABCPD1234K', '987654321098', 'KA0120190001234',
			'50100509155982', 'Clean Person', 'HDFC Bank', 'HDFC0004274',
			'Rita Person', '9998887776'
		]);
		const buffer = await workbook.xlsx.writeBuffer();
		const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
		const row = result.rows[0];

		expect(row.underGraduate).toBe('SSLC');
		expect(row.graduate).toBe('BCom');
		expect(row.masters).toBe('MBA');
		expect(row.aadharNumber).toBe('123456789012');
		expect(row.panNumber).toBe('ABCPD1234K');
		expect(row.uanNumber).toBe('987654321098');
		expect(row.drivingLicenseNumber).toBe('KA0120190001234');
		expect(row.bankAccountNumber).toBe('50100509155982');
		expect(row.bankName).toBe('HDFC Bank');
		expect(row.bankIfsc).toBe('HDFC0004274');
		// Nothing was moved, so the reviewer is shown no repair notes.
		expect(result.repairs[0]).toBeUndefined();
	});

	test('a repeated header fills the field it names the second time', async () => {
		// The tracker labels both the employee's and the emergency contact's
		// number "Contact Number". Dropping the duplicate lost the second one.
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow([
			'Name Of the Champion', 'Official E Mail ', 'Contact Number',
			'Contact Name in case of Emergency', 'Contact Number'
		]);
		sheet.addRow(['Test Person', 't@example.com', '9876543210', 'Rita Person', '9998887776']);
		const buffer = await workbook.xlsx.writeBuffer();
		const row = (await parseHrTeamSheet(Buffer.from(buffer) as never)).rows[0];

		expect(row.phone).toBe('9876543210');
		expect(row.emergencyContactPhone).toBe('9998887776');
	});
});

describe('bank repair', () => {
	test('a block sitting under the personal headers is read', async () => {
		const row = await parseBankRow([
			'Test Person', 't@example.com',
			null, '50100509155982', 'Prasanna kumar M G', 'HDFC Bank', 'HDFC0004274', null, null, null
		]);
		expect(row.bankAccountNumber).toBe('50100509155982');
		expect(row.bankAccountHolderName).toBe('Prasanna kumar M G');
		expect(row.bankName).toBe('HDFC Bank');
		expect(row.bankIfsc).toBe('HDFC0004274');
	});

	test('a block shifted into the salary columns is still read', async () => {
		// Reading only the four mapped columns lost the bank and IFSC here, which
		// is how a profile ended up with an account number but no bank.
		const row = await parseBankRow([
			'Test Person', 't@example.com',
			null, null, null, '1412155000184940', 'Setty Bhavana', 'KVB', 'KVBL0001412', null
		]);
		expect(row.bankAccountNumber).toBe('1412155000184940');
		expect(row.bankAccountHolderName).toBe('Setty Bhavana');
		expect(row.bankName).toBe('KVB');
		expect(row.bankIfsc).toBe('KVBL0001412');
	});

	test('an IFSC typed with a letter O is normalised', async () => {
		// "UBINO900800" — the fifth character must be a zero.
		const row = await parseBankRow([
			'Test Person', 't@example.com',
			null, '8310840203', 'RENUKA L', 'UNION Bank', 'UBINO900800', null, null, null
		]);
		expect(row.bankIfsc).toBe('UBIN0900800');
	});

	test('a bank name missing a space is still recognised', async () => {
		const row = await parseBankRow([
			'Test Person', 't@example.com',
			null, null, null, '3491744142', 'salomi Siraj Dongre', 'CENTRAL BANKOF INDIA', 'CBIN0283774', null
		]);
		expect(row.bankName).toBe('CENTRAL BANKOF INDIA');
		expect(row.bankAccountHolderName).toBe('salomi Siraj Dongre');
	});

	test('an empty bank region yields no invented values', async () => {
		const row = await parseBankRow([
			'Test Person', 't@example.com', null, '-', '-', '-', '-', '-', '-', '-'
		]);
		expect(row.bankAccountNumber).toBeNull();
		expect(row.bankAccountHolderName).toBeNull();
		expect(row.bankName).toBeNull();
		expect(row.bankIfsc).toBeNull();
	});
});

describe('education repair', () => {
	test('a bachelor degree under the Masters header is filed as a graduate one', async () => {
		// The tracker puts Masters straight after Graduate, so a one-column shift
		// is enough to record a BBA as a postgraduate qualification.
		const row = await parseRow([
			'Test Person', 't@example.com',
			null, null, null, null, null,
			null, null, 'BBA'
		]);
		expect(row.graduate).toBe('BBA');
		expect(row.masters).toBeNull();
	});

	test('a real postgraduate qualification stays in Masters', async () => {
		const row = await parseRow([
			'Test Person', 't@example.com',
			null, null, null, null, null,
			null, 'Bcom', 'MBA'
		]);
		expect(row.graduate).toBe('Bcom');
		expect(row.masters).toBe('MBA');
	});

	test('schooling below a degree is recorded as under-graduate', async () => {
		const row = await parseRow([
			'Test Person', 't@example.com',
			null, null, null, null, null,
			'SSLC', 'BCOM', null
		]);
		expect(row.underGraduate).toBe('SSLC');
		expect(row.graduate).toBe('BCOM');
		expect(row.masters).toBeNull();
	});
});

/**
 * The login id comes out of the official-email column, and ExcelJS represents
 * anything but a bare string as an object whose value lives under a different
 * key per cell type. Stringifying those produced the literal "[object Object]",
 * which passed every emptiness check and became the account's email address —
 * an account nobody could ever sign in to, whatever password was mailed out.
 * Master trackers build that column by formula often enough that this was the
 * common case, not the exotic one.
 */
describe('non-scalar cell values', () => {
	/** Builds a one-row workbook, writing raw ExcelJS cell values. */
	async function parseCellValues(values: unknown[]): Promise<ParsedImportRow> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow(HEADERS);
		const row = sheet.getRow(2);
		values.forEach((value, i) => {
			if (value !== null && value !== undefined) row.getCell(i + 1).value = value as never;
		});
		row.commit();
		const buffer = await workbook.xlsx.writeBuffer();
		const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
		return result.rows[0];
	}

	test('a formula cell reads as its computed result, not its formula', async () => {
		const row = await parseCellValues([
			'Test Person',
			{ formula: 'LOWER(A2)&"@example.com"', result: 'test.person@example.com' }
		]);
		expect(row.officialEmail).toBe('test.person@example.com');
	});

	// A tracker fills the email column by dragging one formula down the sheet, so
	// every row below the first is a shared clone rather than a formula of its own.
	test('a shared-formula clone reads as its computed result', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow(HEADERS);
		sheet.getCell('A2').value = 'First Person';
		sheet.getCell('B2').value = {
			formula: 'LOWER(A2)&"@example.com"',
			result: 'first.person@example.com'
		} as never;
		sheet.getCell('A3').value = 'Second Person';
		sheet.getCell('B3').value = {
			sharedFormula: 'B2',
			result: 'second.person@example.com'
		} as never;
		const buffer = await workbook.xlsx.writeBuffer();
		const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
		expect(result.rows.map((r) => r.officialEmail)).toEqual([
			'first.person@example.com',
			'second.person@example.com'
		]);
	});

	test('a rich-text cell reads as its runs joined', async () => {
		const row = await parseCellValues([
			{ richText: [{ text: 'Test ' }, { text: 'Person' }] },
			{ richText: [{ text: 'test.person@' }, { text: 'example.com' }] }
		]);
		expect(row.fullName).toBe('Test Person');
		expect(row.officialEmail).toBe('test.person@example.com');
	});

	test('a hyperlinked email reads as its display text, not its mailto: href', async () => {
		const row = await parseCellValues([
			'Test Person',
			{ text: 'test.person@example.com', hyperlink: 'mailto:test.person@example.com' }
		]);
		expect(row.officialEmail).toBe('test.person@example.com');
	});

	/**
	 * A formula that errored is the absence of a value. Reading it as the text
	 * "#N/A" would put that in the profile; reading it as "[object Object]" was
	 * worse still.
	 */
	test('an errored formula reads as empty, not as the text of the error', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow(HEADERS);
		sheet.getCell('A2').value = 'Good Person';
		sheet.getCell('B2').value = 'good.person@example.com';
		sheet.getCell('E2').value = { error: '#REF!' } as never;
		sheet.getCell('A3').value = 'Broken Person';
		sheet.getCell('B3').value = {
			formula: 'VLOOKUP(A3,X:Y,2,0)',
			result: { error: '#N/A' }
		} as never;
		const buffer = await workbook.xlsx.writeBuffer();
		const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
		// #REF! is the absence of a PAN, not a PAN reading "#REF!".
		expect(result.rows[0].panNumber).toBeNull();
		// And a row whose email never resolved has no login to create, so it is
		// left out entirely rather than imported under "[object object]".
		expect(result.rows).toHaveLength(1);
	});

	test('a value that is not an address is flagged rather than made a login id', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('HR Team Master Tracker');
		sheet.addRow(HEADERS);
		sheet.addRow(['Test Person', 'yet to be created']);
		const buffer = await workbook.xlsx.writeBuffer();
		const result = await parseHrTeamSheet(Buffer.from(buffer) as never);
		expect(result.rows[0].officialEmail).toBe('yet to be created');
		expect(result.repairs[0].join(' ')).toMatch(/officialEmail .* is not an email address/);
	});
});

describe('people with no work email', () => {
	async function parseSheet(headers: string[], rows: (string | null)[][]) {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('Master Tracker');
		sheet.addRow(headers);
		for (const r of rows) sheet.addRow(r);
		const buffer = await workbook.xlsx.writeBuffer();
		return parseHrTeamSheet(Buffer.from(buffer) as never);
	}
	const headers = ['Emp Code', 'Name Of the Employee', 'Team ', 'Official E Mail ', 'Direct Reporting Authority'];

	test('keeps a worker with a reporting manager, under a no-login placeholder', async () => {
		const result = await parseSheet(headers, [
			['INFRATECH0072', 'Hanamanth Havagirao', 'Resorts', 'hanamanth.h@championsmail.com', 'Hema Malini'],
			['INFRATECH0212', 'Ramadass', 'Resorts', null, 'Hanamanth Havagirao']
		]);
		expect(result.strategy).toBe('known-headers');
		expect(result.rows.map((r) => r.officialEmail)).toEqual([
			'hanamanth.h@championsmail.com',
			'infratech0212@no-login.invalid'
		]);
		expect(result.repairs[1]?.[0]).toMatch(/blue collar/);
		expect(result.repairs[0]).toBeUndefined();
	});

	test('keeps a no-email row with only an employee code, to be given a manager at review', async () => {
		const result = await parseSheet(headers, [['INFRATECH0002', 'Watchman', 'Resorts', null, null]]);
		expect(result.rows.map((r) => r.officialEmail)).toEqual(['infratech0002@no-login.invalid']);
	});

	test('leaves out a bare name with no email, code or manager', async () => {
		const result = await parseSheet(headers, [
			['INFRATECH0001', 'Somebody', 'Resorts', 'somebody@championsmail.com', null],
			[null, 'Housekeeping staff', null, null, null]
		]);
		expect(result.rows.map((r) => r.fullName)).toEqual(['Somebody']);
	});
});

describe('reporting-line suggestion', () => {
	const row = (fullName: string, teamAndFloor: string | null, reportingAuthorityRaw: string | null = null) =>
		({ fullName, teamAndFloor, reportingAuthorityRaw }) as ParsedImportRow;

	test('breaks a name tie by the one tied person in the same team', () => {
		const rows = [
			row('Nagesha G', 'Data Team'),
			row('Nagesha H S', 'Sales Team'),
			row('C Nagesh', 'Champion Luxury Resorts'),
			row('Vinay L', 'Champion Luxury Resorts', 'Nagesh')
		];
		expect(suggestReportsToIndex('Nagesh', rows, 3)).toBe(2);
	});

	test('leaves a tie blank when the team does not single anyone out', () => {
		const rows = [row('Nagesha G', 'Data Team'), row('Nagesha H S', 'Data Team'), row('Vinay L', 'Resorts', 'Nagesh')];
		expect(suggestReportsToIndex('Nagesh', rows, 2)).toBeNull();
	});
});
