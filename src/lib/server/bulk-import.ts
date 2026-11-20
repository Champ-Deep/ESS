import ExcelJS from 'exceljs';
import {
	mapSpreadsheet,
	redactCell,
	type SheetMapping,
	type SheetSummary
} from '$lib/server/ai/map-spreadsheet';
import { matchName } from '$lib/server/name-match';
import { noLoginEmail } from '$lib/no-login';

export interface ParsedImportRow {
	// Identity & job — the minimum needed to create a login.
	employeeCode: string | null;
	fullName: string;
	designation: string | null;
	officialEmail: string;
	teamAndFloor: string | null;
	reportingAuthorityRaw: string | null;
	dottedLineAuthorityRaw: string | null;
	subProcessDepartment: string | null;
	floorDetails: string | null;
	dateOfJoining: string | null;
	dateOfConfirmation: string | null;
	officeTimings: string | null;
	shiftType: string | null;
	sourceReferredBy: string | null;

	// Personal & contact
	phone: string | null;
	personalEmail: string | null;
	address: string | null;
	permanentAddress: string | null;
	gender: string | null;
	bloodGroup: string | null;
	dobDocuments: string | null;
	dobActual: string | null;
	religion: string | null;
	motherTongue: string | null;
	facebookId: string | null;
	linkedinUrl: string | null;
	instagramHandle: string | null;

	// Family
	fatherName: string | null;
	fatherDob: string | null;
	fatherContact: string | null;
	motherName: string | null;
	motherDob: string | null;
	motherContact: string | null;
	maritalStatus: string | null;
	spouseName: string | null;
	spouseDob: string | null;
	spouseContact: string | null;
	anniversaryDate: string | null;
	children: { name: string; dob: string | null }[] | null;

	// Emergency contact
	emergencyContactName: string | null;
	emergencyContactRelationship: string | null;
	emergencyContactPhone: string | null;

	// Education & experience
	underGraduate: string | null;
	graduate: string | null;
	masters: string | null;
	diplomaOthers: string | null;
	totalExperience: string | null;

	// Government IDs
	aadharNumber: string | null;
	panNumber: string | null;
	uanNumber: string | null;
	drivingLicenseNumber: string | null;
	votersIdNumber: string | null;
	passportNumber: string | null;

	// Bank
	bankAccountNumber: string | null;
	bankAccountHolderName: string | null;
	bankName: string | null;
	bankIfsc: string | null;
	/**
	 * Staging only. Every cell across the tracker's bank region, in column order.
	 *
	 * The block drifts by a different amount per person — one row's account sits
	 * under "Employee Name as Per Bank", another's under "Bank-IFSC code", a
	 * third's under the repeated salary-bank headers further right. Reading only
	 * the four mapped columns therefore missed whichever fields fell outside
	 * them, which is how rows ended up with an account number but no bank or
	 * IFSC. The whole region is captured and the block rebuilt from it by value
	 * shape. Not persisted — see the bank rebuild in repairMisalignedValues().
	 */
	bankRegionRaw: string[];
}

/** Fields the review UI treats as sensitive; see maskSensitive(). */
export const SENSITIVE_IMPORT_FIELDS = [
	'aadharNumber',
	'panNumber',
	'bankAccountNumber',
	'passportNumber',
	'votersIdNumber',
	'drivingLicenseNumber'
] as const satisfies readonly (keyof ParsedImportRow)[];

// Header names are matched case-insensitively with surrounding whitespace trimmed —
// the source sheet has trailing spaces on several headers (e.g. "Official E Mail ").
// Synonyms cover the naming drift across the HR trackers ("HR Team Master data",
// "HR Team Master Tracker", …) so familiar shapes never need the LLM fallback.
const HEADER_MAP: Record<string, keyof ParsedImportRow> = {
	'cipl emp code': 'employeeCode',
	'emp code': 'employeeCode',
	'employee code': 'employeeCode',
	'employee id': 'employeeCode',
	'name of the champion': 'fullName',
	'name of the employee': 'fullName',
	'employee name': 'fullName',
	name: 'fullName',
	designation: 'designation',
	'team and floor': 'teamAndFloor',
	team: 'teamAndFloor',
	department: 'teamAndFloor',
	'direct reporting authority': 'reportingAuthorityRaw',
	'reporting authority': 'reportingAuthorityRaw',
	'reporting manager': 'reportingAuthorityRaw',
	'reports to': 'reportingAuthorityRaw',
	'official e mail': 'officialEmail',
	'official e-mail': 'officialEmail',
	'official email': 'officialEmail',
	'official mail id': 'officialEmail',
	'official email id': 'officialEmail',
	'email id': 'officialEmail',
	email: 'officialEmail',
	'work email': 'officialEmail',

	'dotted line reporting authority': 'dottedLineAuthorityRaw',
	'dotted line reporting': 'dottedLineAuthorityRaw',
	'sub process / department': 'subProcessDepartment',
	'sub process/department': 'subProcessDepartment',
	'sub process': 'subProcessDepartment',
	'floor details': 'floorDetails',
	'date of joining': 'dateOfJoining',
	doj: 'dateOfJoining',
	'date of confirmation': 'dateOfConfirmation',
	'office timings': 'officeTimings',
	'type of shift': 'shiftType',
	shift: 'shiftType',
	'source/ referred by': 'sourceReferredBy',
	'source / referred by': 'sourceReferredBy',
	'source/referred by': 'sourceReferredBy',

	'contact number': 'phone',
	'contact no': 'phone',
	'mobile number': 'phone',
	phone: 'phone',
	'personal e mail': 'personalEmail',
	'personal e-mail': 'personalEmail',
	'personal email': 'personalEmail',
	'present address': 'address',
	'current address': 'address',
	'permanent address': 'permanentAddress',
	gender: 'gender',
	'blood group': 'bloodGroup',
	'date of birth as per documents': 'dobDocuments',
	'dob as per documents': 'dobDocuments',
	'actual dob': 'dobActual',
	religion: 'religion',
	'mother tongue': 'motherTongue',
	'facebook id': 'facebookId',
	linkedin: 'linkedinUrl',
	'linkedin id': 'linkedinUrl',
	instagram: 'instagramHandle',
	'instagram id': 'instagramHandle',

	'father name': 'fatherName',
	"father's name": 'fatherName',
	'father contact': 'fatherContact',
	'mother name': 'motherName',
	"mother's name": 'motherName',
	'mother contact': 'motherContact',
	'marital status': 'maritalStatus',
	'spouse name': 'spouseName',
	'spouse d.o.b': 'spouseDob',
	'spouse dob': 'spouseDob',
	'spouse contact #': 'spouseContact',
	'spouse contact': 'spouseContact',
	'date of anniversary': 'anniversaryDate',
	'anniversary date': 'anniversaryDate',

	'contact name in case of emergency': 'emergencyContactName',
	'emergency contact name': 'emergencyContactName',
	'emergency contact relationship': 'emergencyContactRelationship',
	'emergency contact number': 'emergencyContactPhone',
	'contact number in case of emergency': 'emergencyContactPhone',
	// The NON CIPL tracker's emergency-contact relationship, which sits right
	// after "Contact Name in case of Emergency".
	relationship: 'emergencyContactRelationship',
	'father dob': 'fatherDob',
	'mother dob': 'motherDob',

	'under graduate': 'underGraduate',
	graduate: 'graduate',
	masters: 'masters',
	'diploma/others': 'diplomaOthers',
	'diploma / others': 'diplomaOthers',
	'total experience in years': 'totalExperience',
	'total experience': 'totalExperience',

	'aadhar number': 'aadharNumber',
	'aadhaar number': 'aadharNumber',
	'pan no': 'panNumber',
	'pan number': 'panNumber',
	'uan number': 'uanNumber',
	'dl #': 'drivingLicenseNumber',
	'driving license': 'drivingLicenseNumber',
	'voters id #': 'votersIdNumber',
	'voters id': 'votersIdNumber',
	'passport no': 'passportNumber',
	'passport number': 'passportNumber',

	'personal bank account #': 'bankAccountNumber',
	'bank account #': 'bankAccountNumber',
	'bank account number': 'bankAccountNumber',
	'employee name as per bank': 'bankAccountHolderName',
	'bank name': 'bankName',
	'bank-ifsc code': 'bankIfsc',
	'bank ifsc code': 'bankIfsc',
	ifsc: 'bankIfsc'
	// The salary-bank headers repeated after the personal block are not mapped:
	// every cell in the bank region is captured positionally into
	// bankRegionRaw instead. See findBankRegion().
};

/**
 * Headers that bound the tracker's bank region.
 *
 * The region runs from the first bank-ish header to the last, and a drifted row
 * can place any of its four values anywhere inside it — so the span is read
 * wholesale rather than column by column.
 */
const BANK_REGION_HEADERS =
	/^(personal bank account|bank account|employee name as per bank|bank name|bank[-\s]?ifsc|salary bank account|bank)\b/i;

function normalizeHeader(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

/**
 * HR trackers use "-", "NA" and "N/A" as "nothing here". Treating them as real
 * values would litter profiles with dashes and, worse, make a blank field look
 * populated.
 */
const PLACEHOLDER_CELLS = new Set(['-', '--', 'na', 'n/a', 'nil', 'none', 'null']);

function meaningful(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim().replace(/'+$/, ''); // sheets suffix ' to force text
	if (trimmed === '' || PLACEHOLDER_CELLS.has(trimmed.toLowerCase())) return null;
	return trimmed;
}

// --- Content-based field recognition -------------------------------------
//
// The master tracker's header row drifts out of alignment with its data, and by
// a different amount on different rows — one person's Aadhaar column holds
// "2.8 yrs", another's holds a real number. Since a header alone cannot be
// trusted, values that have a recognisable shape are verified against it, and
// a value that clearly belongs to a different field is moved there.

const looksLikeAadhaar = (v: string) => /^\d{12}$/.test(v.replace(/\s/g, ''));
const looksLikePan = (v: string) => /^[A-Z]{5}\d{4}[A-Z]$/i.test(v.trim());
const looksLikeIfsc = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v.trim());
const looksLikeUan = (v: string) => /^\d{12}$/.test(v.replace(/\s/g, ''));
const looksLikePhone = (v: string) => /^(\+?91[-\s]?)?[6-9]\d{9}$/.test(v.replace(/[-\s]/g, ''));
const looksLikeExperience = (v: string) => /^\d+(\.\d+)?\s*(yrs?|years?)$/i.test(v.trim());
// An Indian driving licence is state-code + digits, e.g. "KA5120170071762".
// Requiring a letter keeps bare 12-digit Aadhaar/UAN values out of the field.
const looksLikeDrivingLicense = (v: string) => /^[A-Z]{2}[\s-]?\d[\d\s-]{6,}$/i.test(v.trim());
/**
 * Exported because the official-email column is not just another field: it
 * becomes the account's login id, and this portal authenticates by email. A
 * value that isn't an address here produces an account nobody can ever sign in
 * to, so the upload step holds such a row for review instead of creating it.
 */
export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Repairs a parsed row whose values landed under the wrong headers.
 *
 * Only unambiguous shapes are moved (a 12-digit number, a PAN pattern, an IFSC
 * code), and a value is only relocated into a field that is currently empty —
 * so real data is never overwritten by a guess. Anything still uncertain is
 * left where it was for a human to judge in the review screen.
 */
function repairMisalignedValues(row: ParsedImportRow): string[] {
	const notes: string[] = [];

	// The government-ID block drifts as a unit (experience / Aadhaar / PAN /
	// UAN), so like the bank block it is rebuilt from value shape rather than
	// position: Aadhaar and UAN are 12 digits, PAN has a fixed letter/digit
	// pattern, and an experience value reads as "2.8 yrs". Rebuilding by shape
	// handles a one-column drift and a three-column drift identically.
	const idPool = [
		row.totalExperience,
		row.aadharNumber,
		row.panNumber,
		row.uanNumber,
		row.drivingLicenseNumber
	].filter((v): v is string => v != null);

	const foundPan = idPool.find(looksLikePan);
	const foundExperience = idPool.find(looksLikeExperience);
	const twelveDigit = idPool.filter((v) => looksLikeAadhaar(v) || looksLikeUan(v));
	// Aadhaar and UAN are both 12 digits and indistinguishable by shape alone;
	// the sheet always lists Aadhaar first, so keep that order.
	const [foundAadhaar, foundUan] = twelveDigit;

	if (foundPan || foundExperience || twelveDigit.length > 0) {
		const rebuiltIds = {
			totalExperience: foundExperience ?? null,
			aadharNumber: foundAadhaar ?? null,
			panNumber: foundPan ?? null,
			uanNumber: foundUan ?? null
		};
		const idsChanged =
			row.totalExperience !== rebuiltIds.totalExperience ||
			row.aadharNumber !== rebuiltIds.aadharNumber ||
			row.panNumber !== rebuiltIds.panNumber ||
			row.uanNumber !== rebuiltIds.uanNumber ||
			// A row whose only fault is a non-licence in the licence column still
			// needs the rebuild to run so that value gets cleared.
			(row.drivingLicenseNumber != null && !looksLikeDrivingLicense(row.drivingLicenseNumber));

		if (idsChanged) {
			// Anything left over that wasn't claimed (e.g. a licence number) stays
			// on drivingLicenseNumber rather than being silently dropped.
			//
			// Claims are consumed BY POSITION, not by value: a row with a UAN but no
			// Aadhaar has one 12-digit number filling one pool slot, and matching on
			// the string alone left that same slot looking unclaimed — so the UAN was
			// copied into the licence field as well.
			const claimedIndexes = new Set<number>();
			for (const claim of [foundExperience, foundAadhaar, foundPan, foundUan]) {
				if (claim == null) continue;
				const at = idPool.findIndex((v, i) => v === claim && !claimedIndexes.has(i));
				if (at !== -1) claimedIndexes.add(at);
			}
			const leftover = idPool.find((v, i) => !claimedIndexes.has(i));

			row.totalExperience = rebuiltIds.totalExperience;
			row.aadharNumber = rebuiltIds.aadharNumber;
			row.panNumber = rebuiltIds.panNumber;
			row.uanNumber = rebuiltIds.uanNumber;
			// The licence column is part of the same drifted block, so whatever sat
			// under its header is rebuilt too rather than left in place. An Indian DL
			// carries a state code ("KA5120170071762"); a bare number there is an
			// unlabelled Aadhaar/UAN or a stray figure like "14.5" years of service,
			// and recording either as a licence is worse than leaving it empty.
			row.drivingLicenseNumber =
				leftover && looksLikeDrivingLicense(leftover) ? leftover : null;
			notes.push('government IDs re-matched by value shape');
		}
	}

	// The bank block drifts by varying amounts between rows, so it is rebuilt
	// from content rather than position: across the four bank columns exactly
	// one value looks like an account number, one like an IFSC code, and the
	// rest are names. Reassigning by shape is reliable where a fixed offset is
	// not.
	const bankValues = [
		row.bankAccountNumber,
		row.bankAccountHolderName,
		row.bankName,
		row.bankIfsc,
		...row.bankRegionRaw
	].filter((v): v is string => v != null);
	if (bankValues.length > 0) {
		// An IFSC is four letters, a zero, then six alphanumerics — but the sheet
		// contains at least one typed with a letter O for that zero ("UBINO900800"),
		// so a near-miss in an otherwise IFSC-shaped value is accepted and
		// normalised rather than discarded as "not a code".
		const ifscRaw = bankValues.find((v) => looksLikeIfsc(v) || /^[A-Z]{4}O[A-Z0-9]{6}$/i.test(v));
		const ifsc = ifscRaw
			? `${ifscRaw.slice(0, 4)}0${ifscRaw.slice(5)}`.toUpperCase()
			: undefined;
		// A 12-digit value in this region is an Aadhaar or UAN that drifted in from
		// the ID block, not a bank account. Those are claimed by the ID rebuild, so
		// exclude anything it already took.
		const claimedById = new Set(
			[row.aadharNumber, row.uanNumber, row.panNumber].filter(Boolean) as string[]
		);
		const account = bankValues.find(
			(v) => /^\d{9,18}$/.test(v) && !claimedById.has(v) && v !== ifscRaw
		);
		// A bank's name says so ("HDFC Bank", "SBI", "KVB", "BOI"); the remaining
		// person-like value is the account holder.
		const bankNamed = bankValues.find(
			(v) =>
				v !== account &&
				v !== ifscRaw &&
				// "BANKOF" in "CENTRAL BANKOF INDIA" is a missing space in the source, so
			// the word is matched without requiring a boundary after it.
			(/\bbank/i.test(v) || /^(sbi|kvb|boi|hdfc|icici|axis|pnb|idbi)$/i.test(v.trim()))
		);
		const holder = bankValues.find(
			(v) =>
				v !== account &&
				v !== ifscRaw &&
				v !== bankNamed &&
				!claimedById.has(v) &&
				// A holder is a written name, not a code or a stray label.
				/^[a-z][a-z\s.'-]{2,}$/i.test(v)
		);

		const rebuilt = { account, holder, bankNamed, ifsc };
		const changed =
			row.bankAccountNumber !== (account ?? null) ||
			row.bankAccountHolderName !== (holder ?? null) ||
			row.bankName !== (bankNamed ?? null) ||
			row.bankIfsc !== (ifsc ?? null);

		if (changed) {
			row.bankAccountNumber = rebuilt.account ?? null;
			row.bankAccountHolderName = rebuilt.holder ?? null;
			row.bankName = rebuilt.bankNamed ?? null;
			row.bankIfsc = rebuilt.ifsc ?? null;
			notes.push('bank details re-matched by value shape');
		}
	}

	// The emergency-contact block drifts by different amounts per row, and on
	// some rows a stray date occupies the name column. Rebuild it by shape from
	// the columns the block is known to spill into: a phone number is the
	// contact number, a relationship word is the relationship, and a remaining
	// person-like name is the contact.
	const RELATIONSHIPS =
		/^(father|mother|brother|sister|spouse|husband|wife|son|daughter|uncle|aunt|guardian|gardian|friend|cousin|in.?law)/i;
	const isDateLike = (v: string) => /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v);

	const emergencyPool = [
		row.emergencyContactName,
		row.emergencyContactRelationship,
		row.emergencyContactPhone,
		row.underGraduate,
		row.graduate,
		row.masters,
		row.diplomaOthers
	].filter((v): v is string => v != null && !isDateLike(v));

	const emPhone = emergencyPool.find(looksLikePhone);
	// A relationship arrives either alone ("Father") or appended to the name
	// ("Sabiha Dongre/ Sister", "Anil / Friend").
	const relationSource = emergencyPool.find((v) => RELATIONSHIPS.test(v) || /[/,]/.test(v));
	const emRelation = relationSource
		? (relationSource
				.split(/[/,]/)
				.map((part) => part.trim())
				.find((part) => RELATIONSHIPS.test(part)) ?? null)
		: null;
	const emName = emergencyPool.find(
		(v) =>
			v !== emPhone &&
			v !== emRelation &&
			/^[a-z][a-z\s./'-]{2,}$/i.test(v) &&
			!/^(sslc|bba|bcom|btech|ba|mba|diploma)/i.test(v)
	);

	if (emPhone && row.emergencyContactPhone !== emPhone) {
		row.emergencyContactPhone = emPhone;
		notes.push('emergency contact number re-matched by value shape');
	}
	if (emRelation && row.emergencyContactRelationship !== emRelation) {
		row.emergencyContactRelationship = emRelation;
	}
	if (emName && row.emergencyContactName !== emName) {
		// Strip a relationship that was written into the name cell.
		const cleaned = emName
			.split(/[/,]/)
			.map((part) => part.trim())
			.find((part) => part && !RELATIONSHIPS.test(part));
		row.emergencyContactName = cleaned ?? emName;
	}
	// A date is never a contact name — drop it rather than show it as one.
	if (row.emergencyContactName && isDateLike(row.emergencyContactName)) {
		row.emergencyContactName = null;
		notes.push('emergency contact name held a date; cleared');
	}

	// Education columns hold emergency-contact data on the drifted rows. Clear
	// anything that isn't a qualification — a phone number, a relationship, a
	// date, or a value already claimed as the emergency contact — so a relative's
	// name never surfaces as someone's degree.
	const claimedByEmergency = new Set(
		[emPhone, emRelation, emName, relationSource].filter(Boolean) as string[]
	);
	// A qualification is a short token like BBA/BCom/MBA/Diploma. Anything that
	// names a person or a relationship came from the drifted contact block.
	const looksLikeQualification = (v: string) =>
		/^(ssl?c|puc|hsc|b\.?[a-z]{1,4}|m\.?[a-z]{1,4}|diploma|degree|graduate|phd|ca|iti)\b/i.test(
			v.trim()
		);
	for (const field of ['underGraduate', 'graduate', 'masters', 'diplomaOthers'] as const) {
		const value = row[field];
		if (!value) continue;
		if (
			looksLikePhone(value) ||
			RELATIONSHIPS.test(value) ||
			isDateLike(value) ||
			claimedByEmergency.has(value) ||
			(/[/,]/.test(value) && !looksLikeQualification(value))
		) {
			row[field] = null;
		}
	}

	// The education block drifts as a unit too, which lands a bachelor's degree
	// under "Masters" — the tracker's own header order puts Masters immediately
	// after Graduate, so a one-column shift is enough. Re-sort what survived by
	// the level the qualification actually names rather than by the column it
	// arrived in; a postgraduate token (MBA, MCom, MSc, PhD) is a master's and a
	// bachelor token (BBA, BCom, BA, BTech) is not.
	const isMastersLevel = (v: string) => /^(m\.?[a-z]{1,4}|phd|ca)\b/i.test(v.trim());
	const isBachelorsLevel = (v: string) => /^(b\.?[a-z]{1,4})\b/i.test(v.trim());

	const educationPool = [row.underGraduate, row.graduate, row.masters].filter(
		(v): v is string => v != null
	);
	if (educationPool.length > 0) {
		const masters = educationPool.find(isMastersLevel) ?? null;
		const bachelors = educationPool.find(isBachelorsLevel) ?? null;
		// Anything that is neither (SSLC, PUC, a diploma) is schooling below a
		// degree, which is what the tracker's "Under Graduate" column records.
		const preDegree = educationPool.find((v) => !isMastersLevel(v) && !isBachelorsLevel(v)) ?? null;

		if (row.masters !== masters || row.graduate !== bachelors || row.underGraduate !== preDegree) {
			row.underGraduate = preDegree;
			row.graduate = bachelors;
			row.masters = masters;
			notes.push('education re-matched by qualification level');
		}
	}

	// The official email is the login id. Anything else in that column — a
	// "yet to be created", a name, a formula the parser could not resolve —
	// would otherwise become an account address that its owner can never sign
	// in with, so say so loudly on the review screen.
	if (!looksLikeEmail(row.officialEmail)) {
		notes.push(`officialEmail "${row.officialEmail}" is not an email address — this would be the login id`);
	}

	// Flag rather than move: a non-email in the personal-email column means the
	// row drifted somewhere upstream, which a reviewer should see.
	if (row.personalEmail && !looksLikeEmail(row.personalEmail)) {
		notes.push(`personalEmail "${row.personalEmail}" is not an email address`);
	}
	if (row.uanNumber && !looksLikeUan(row.uanNumber) && !/^\d+$/.test(row.uanNumber)) {
		notes.push(`uanNumber "${row.uanNumber}" is not a 12-digit UAN`);
	}

	return notes;
}

/**
 * Collapses the tracker's fixed "Kids Name #n / Date of Birth" column pairs into
 * a list, dropping the placeholder rows for people with fewer children.
 */
function collectChildren(
	row: ExcelJS.Row,
	pairs: { nameCol: number; dobCol: number | null }[]
): { name: string; dob: string | null }[] | null {
	const kids: { name: string; dob: string | null }[] = [];
	for (const { nameCol, dobCol } of pairs) {
		const name = meaningful(cellText(row.getCell(nameCol).value));
		if (!name) continue;
		const dob = dobCol ? meaningful(cellText(row.getCell(dobCol).value)) : null;
		kids.push({ name, dob });
	}
	return kids.length > 0 ? kids : null;
}

/**
 * Finds the column span covering the tracker's bank headers.
 *
 * Returns the first and last bank-ish column so a drifted value sitting under a
 * neighbouring header is still read. Nothing outside the span is touched.
 */
function findBankRegion(
	sheet: ExcelJS.Worksheet,
	headerRowNumber: number
): { start: number; end: number } | null {
	let start: number | null = null;
	let end: number | null = null;
	sheet.getRow(headerRowNumber).eachCell({ includeEmpty: false }, (cell, colNumber) => {
		if (!BANK_REGION_HEADERS.test(normalizeHeader(cell.value))) return;
		if (start === null) start = colNumber;
		end = colNumber;
	});
	if (start === null || end === null) return null;
	// The block drifts rightward, so the furthest-shifted row spills past the last
	// bank header. Extend by the width of one block so those values are still
	// read; anything picked up beyond it has to look like bank data to be used.
	return { start, end: end + BANK_REGION_OVERFLOW };
}

/** Columns past the last bank header that a drifted block can spill into. */
const BANK_REGION_OVERFLOW = 4;

function cellText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	// Excel dates arrive as Date objects; String() would render them as
	// "Wed Jun 21 2023 05:30:00 GMT+0530", which is neither storable in a date
	// column nor readable. Normalise to ISO (YYYY-MM-DD) instead.
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
	}

	// ExcelJS hands back an object for every cell that isn't a bare scalar, and
	// each shape carries its value under a different key. String() on any of them
	// yields the literal "[object Object]" — which used to sail through as a real
	// value and, in the official-email column, became somebody's login id. Every
	// shape is unwrapped here, and an unrecognised one reads as empty rather than
	// as that placeholder text.
	if (typeof value === 'object') {
		const cell = value as Record<string, unknown>;
		// { formula, result } and { sharedFormula, result }. The master tracker
		// builds official emails from the name columns, so this is the common case
		// for the one field the whole login depends on. `result` may itself be a
		// date, an error, or rich text, hence the recursion.
		if ('formula' in cell || 'sharedFormula' in cell) return cellText(cell.result);
		// #N/A, #REF!, #VALUE! — the absence of a value, not the text "#N/A".
		if ('error' in cell) return null;
		// Rich text is a run list; the cell's value is the runs joined.
		if (Array.isArray(cell.richText)) {
			return cellText(cell.richText.map((run) => (run as { text?: unknown }).text ?? '').join(''));
		}
		// { text, hyperlink } — a mailto: link on an email cell. The display text
		// is the value; the href is not.
		if ('text' in cell) return cellText(cell.text);
		return null;
	}

	const s = String(value).trim();
	return s === '' ? null : s;
}

export interface ParseResult {
	rows: ParsedImportRow[];
	/** Which sheet was used, and how it was chosen — surfaced in the review UI. */
	sheetName: string;
	strategy: 'known-headers' | 'ai-mapped';
	note: string | null;
	/**
	 * Per-row data-quality notes keyed by row index: values relocated out of a
	 * mislabelled column, and values that still look wrong. Shown in the review
	 * screen so a corrected import is never silently corrected.
	 */
	repairs: Record<number, string[]>;
}

/**
 * Locates the tracker's repeating "Kids Name #n" / "Date of Birth" column pairs.
 * They share the header "Date of Birth" with each other, so they are found by
 * position — the DOB column immediately following each kid-name column.
 */
function findChildColumns(
	sheet: ExcelJS.Worksheet,
	headerRowNumber: number
): { nameCol: number; dobCol: number | null }[] {
	const header = sheet.getRow(headerRowNumber);
	const pairs: { nameCol: number; dobCol: number | null }[] = [];
	header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
		if (!/^kids?\s*name\s*#?\d*$/i.test(normalizeHeader(cell.value))) return;
		const next = normalizeHeader(header.getCell(colNumber + 1).value);
		pairs.push({
			nameCol: colNumber,
			dobCol: /date of birth|dob/.test(next) ? colNumber + 1 : null
		});
	});
	return pairs;
}

/** Reads a sheet given an explicit header row and column-number map. */
function readRows(
	sheet: ExcelJS.Worksheet,
	headerRowNumber: number,
	columnIndex: Partial<Record<keyof ParsedImportRow, number>>
): { rows: ParsedImportRow[]; repairs: Record<number, string[]> } {
	const rows: ParsedImportRow[] = [];
	const repairs: Record<number, string[]> = {};
	const childColumns = findChildColumns(sheet, headerRowNumber);
	const bankRegion = findBankRegion(sheet, headerRowNumber);

	const at = (row: ExcelJS.Row, field: keyof ParsedImportRow) => {
		const col = columnIndex[field];
		return col ? meaningful(cellText(row.getCell(col).value)) : null;
	};

	sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
		if (rowNumber <= headerRowNumber) return;

		const fullName = at(row, 'fullName');
		if (!fullName) return;
		// No work email: possibly blue-collar staff (drivers, housekeeping,
		// kitchen), kept under a placeholder address (src/lib/no-login.ts) for
		// the reviewer to confirm and give a manager. A bare name with neither an
		// employee code nor a manager is not someone to ask about — trackers
		// carry section headings and notes in the name column.
		const workEmail = at(row, 'officialEmail');
		if (!workEmail && !at(row, 'reportingAuthorityRaw') && !at(row, 'employeeCode')) return;
		const officialEmail = workEmail ?? noLoginEmail(at(row, 'employeeCode'), fullName);

		const parsed: ParsedImportRow = {
			employeeCode: at(row, 'employeeCode'),
			fullName,
			designation: at(row, 'designation'),
			officialEmail: officialEmail.toLowerCase(),
			teamAndFloor: at(row, 'teamAndFloor'),
			reportingAuthorityRaw: at(row, 'reportingAuthorityRaw'),
			dottedLineAuthorityRaw: at(row, 'dottedLineAuthorityRaw'),
			subProcessDepartment: at(row, 'subProcessDepartment'),
			floorDetails: at(row, 'floorDetails'),
			dateOfJoining: at(row, 'dateOfJoining'),
			dateOfConfirmation: at(row, 'dateOfConfirmation'),
			officeTimings: at(row, 'officeTimings'),
			shiftType: at(row, 'shiftType'),
			sourceReferredBy: at(row, 'sourceReferredBy'),

			phone: at(row, 'phone'),
			personalEmail: at(row, 'personalEmail'),
			address: at(row, 'address'),
			permanentAddress: at(row, 'permanentAddress'),
			gender: at(row, 'gender'),
			bloodGroup: at(row, 'bloodGroup'),
			dobDocuments: at(row, 'dobDocuments'),
			dobActual: at(row, 'dobActual'),
			religion: at(row, 'religion'),
			motherTongue: at(row, 'motherTongue'),
			facebookId: at(row, 'facebookId'),
			linkedinUrl: at(row, 'linkedinUrl'),
			instagramHandle: at(row, 'instagramHandle'),

			fatherName: at(row, 'fatherName'),
			fatherDob: at(row, 'fatherDob'),
			fatherContact: at(row, 'fatherContact'),
			motherName: at(row, 'motherName'),
			motherDob: at(row, 'motherDob'),
			motherContact: at(row, 'motherContact'),
			maritalStatus: at(row, 'maritalStatus'),
			spouseName: at(row, 'spouseName'),
			spouseDob: at(row, 'spouseDob'),
			spouseContact: at(row, 'spouseContact'),
			anniversaryDate: at(row, 'anniversaryDate'),
			children: collectChildren(row, childColumns),

			emergencyContactName: at(row, 'emergencyContactName'),
			emergencyContactRelationship: at(row, 'emergencyContactRelationship'),
			emergencyContactPhone: at(row, 'emergencyContactPhone'),

			underGraduate: at(row, 'underGraduate'),
			graduate: at(row, 'graduate'),
			masters: at(row, 'masters'),
			diplomaOthers: at(row, 'diplomaOthers'),
			totalExperience: at(row, 'totalExperience'),

			aadharNumber: at(row, 'aadharNumber'),
			panNumber: at(row, 'panNumber'),
			uanNumber: at(row, 'uanNumber'),
			drivingLicenseNumber: at(row, 'drivingLicenseNumber'),
			votersIdNumber: at(row, 'votersIdNumber'),
			passportNumber: at(row, 'passportNumber'),

			bankAccountNumber: at(row, 'bankAccountNumber'),
			bankAccountHolderName: at(row, 'bankAccountHolderName'),
			bankName: at(row, 'bankName'),
			bankIfsc: at(row, 'bankIfsc'),
			bankRegionRaw: bankRegion
				? Array.from({ length: bankRegion.end - bankRegion.start + 1 }, (_, i) =>
						meaningful(cellText(row.getCell(bankRegion.start + i).value))
					).filter((v): v is string => v !== null)
				: []
		};

		const notes = repairMisalignedValues(parsed);
		if (!workEmail) notes.unshift('no work email: confirm they are blue collar (no login; their reporting manager opens their portal for them), or add their email');
		if (notes.length > 0) repairs[rows.length] = notes;
		rows.push(parsed);
	});

	return { rows, repairs };
}

/**
 * Finds the worksheet the model named, tolerating the ways a model rewrites a
 * name: trimmed trailing spaces, case differences, or a close-but-partial name.
 * Sheet names in real HR workbooks routinely carry invisible trailing spaces,
 * and exceljs's getWorksheet() is exact-match only.
 */
function resolveSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
	const exact = workbook.getWorksheet(name);
	if (exact) return exact;

	const norm = (s: string) => s.trim().toLowerCase();
	const target = norm(name);

	const caseInsensitive = workbook.worksheets.filter((s) => norm(s.name) === target);
	if (caseInsensitive.length === 1) return caseInsensitive[0];

	const partial = workbook.worksheets.filter(
		(s) => norm(s.name).includes(target) || target.includes(norm(s.name))
	);
	if (partial.length === 1) return partial[0];

	// A one-sheet workbook leaves no room for ambiguity about which sheet was meant.
	if (workbook.worksheets.length === 1) return workbook.worksheets[0];
	return undefined;
}

/**
 * Where a repeated header belongs the second time it appears.
 *
 * The tracker labels several distinct columns identically — "Contact Number" is
 * the employee's and then, further right, the emergency contact's. The first
 * occurrence is always the one the header names; a repeat carries the next
 * thing in that group. Without this a duplicate was simply dropped, which lost
 * the emergency contact number on every correctly-aligned row.
 */
const REPEATED_HEADER_FALLBACK: Partial<Record<keyof ParsedImportRow, keyof ParsedImportRow>> = {
	phone: 'emergencyContactPhone'
};

/** Tries the known header names against one sheet's given header row. */
function matchKnownHeaders(
	sheet: ExcelJS.Worksheet,
	headerRowNumber: number
): Partial<Record<keyof ParsedImportRow, number>> {
	const columnIndex: Partial<Record<keyof ParsedImportRow, number>> = {};
	sheet.getRow(headerRowNumber).eachCell({ includeEmpty: false }, (cell, colNumber) => {
		const field = HEADER_MAP[normalizeHeader(cell.value)];
		if (!field) return;
		// First occurrence wins: the employee's own column always precedes the
		// repeat, and letting a duplicate overwrite would put the wrong person's
		// number on the profile.
		if (columnIndex[field] === undefined) {
			columnIndex[field] = colNumber;
			return;
		}
		// A repeat is real data under a reused label, so it falls through to the
		// field that label means the second time round rather than being dropped.
		const fallback = REPEATED_HEADER_FALLBACK[field];
		if (fallback && columnIndex[fallback] === undefined) columnIndex[fallback] = colNumber;
	});
	return columnIndex;
}

/**
 * Parses an HR spreadsheet into one row per person.
 *
 * Sheet names and column headers are NOT assumed: every sheet is tried against
 * the known header set first (instant, offline, and unchanged for files we
 * already understand). Only when no sheet matches does the LLM inspect the
 * workbook's structure and decide the mapping, so an unfamiliar export — a
 * renamed sheet, reordered or reworded columns — still imports.
 *
 * Cell values sent to the model are redacted; see redactCell.
 */
export async function parseHrTeamSheet(buffer: Buffer): Promise<ParseResult> {
	const workbook = new ExcelJS.Workbook();
	// exceljs's Buffer type predates newer @types/node Buffer fields (maxByteLength, etc.)
	await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

	const sheets = workbook.worksheets;
	if (sheets.length === 0) throw new Error('This workbook has no sheets');

	// --- 1. Deterministic pass: any sheet whose headers we already recognise.
	// Header rows are usually row 1, but tolerate a title row or two above it.
	let best: { sheet: ExcelJS.Worksheet; headerRow: number; index: Partial<Record<keyof ParsedImportRow, number>> } | null =
		null;

	for (const sheet of sheets) {
		for (let headerRow = 1; headerRow <= Math.min(3, sheet.rowCount); headerRow++) {
			const index = matchKnownHeaders(sheet, headerRow);
			if (index.fullName && index.officialEmail) {
				const score = Object.keys(index).length;
				const bestScore = best ? Object.keys(best.index).length : -1;
				if (score > bestScore) best = { sheet, headerRow, index };
			}
		}
	}

	if (best) {
		const { rows, repairs } = readRows(best.sheet, best.headerRow, best.index);
		if (rows.length > 0) {
			return {
				rows,
				sheetName: best.sheet.name,
				strategy: 'known-headers',
				note: null,
				repairs
			};
		}
	}

	// --- 2. LLM pass: nothing matched, so let the model decide.
	const summaries: SheetSummary[] = sheets.map((sheet) => {
		const sampleRows: string[][] = [];
		const limit = Math.min(4, sheet.rowCount);
		for (let r = 1; r <= limit; r++) {
			const cells: string[] = [];
			sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
				const text = cellText(cell.value) ?? '';
				// Row 1 is nearly always headers and carries no personal data —
				// send it verbatim so the model can match on exact header text.
				cells.push(r === 1 ? text : redactCell(text));
			});
			sampleRows.push(cells);
		}
		return { name: sheet.name, rowCount: sheet.rowCount, sampleRows };
	});

	let mapping: SheetMapping;
	try {
		mapping = await mapSpreadsheet(summaries);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Could not recognise this spreadsheet's layout, and automatic mapping failed: ${detail}`
		);
	}

	const sheet = resolveSheet(workbook, mapping.sheetName);
	if (!sheet) {
		const available = workbook.worksheets.map((s) => `"${s.name}"`).join(', ');
		throw new Error(
			`Automatic mapping chose sheet "${mapping.sheetName}", which isn't in this workbook (sheets found: ${available})`
		);
	}

	// Resolve the model's header TEXT back to column numbers.
	const headerToCol = new Map<string, number>();
	sheet.getRow(mapping.headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
		const text = cellText(cell.value);
		if (text) headerToCol.set(normalizeHeader(text), colNumber);
	});

	const resolve = (header: string | null) =>
		header ? headerToCol.get(normalizeHeader(header)) : undefined;

	const index: Partial<Record<keyof ParsedImportRow, number>> = {
		employeeCode: resolve(mapping.columns.employeeCode),
		fullName: resolve(mapping.columns.fullName),
		designation: resolve(mapping.columns.designation),
		officialEmail: resolve(mapping.columns.officialEmail),
		teamAndFloor: resolve(mapping.columns.teamAndFloor),
		reportingAuthorityRaw: resolve(mapping.columns.reportingAuthority)
	};

	if (!index.fullName || !index.officialEmail) {
		const missing = [!index.fullName && 'employee name', !index.officialEmail && 'work email']
			.filter(Boolean)
			.join(' and ');
		throw new Error(
			`Could not find a ${missing} column in "${sheet.name}"${mapping.note ? ` — ${mapping.note}` : ''}`
		);
	}

	// The model is only asked to find the columns needed to create a login. Every
	// other field is filled in from the known header names on the row the model
	// identified as the header — so an unfamiliar sheet still imports full
	// profiles rather than just names and emails.
	const byHeader = matchKnownHeaders(sheet, mapping.headerRow);
	for (const [field, column] of Object.entries(byHeader)) {
		const key = field as keyof ParsedImportRow;
		if (index[key] === undefined) index[key] = column;
	}

	const { rows, repairs } = readRows(sheet, mapping.headerRow, index);

	return {
		rows,
		sheetName: sheet.name,
		strategy: 'ai-mapped',
		note: mapping.note ?? null,
		repairs
	};
}

/**
 * Finds an existing user whose full name closely matches this row's name but whose
 * email DIDN'T already match (so the plain email-based existing-user check missed
 * them) — e.g. a sheet listing someone's work-issued email while their real login
 * uses a different domain. Returned as a suggestion for the Super Admin to confirm
 * ("link to this existing person?") rather than silently creating a duplicate account.
 */
export function suggestExistingUserMatch<T extends { id: string; fullName: string }>(
	rowFullName: string,
	existingUsers: T[]
): T | null {
	const result = matchName(
		rowFullName,
		existingUsers.map((u) => ({ key: u.id, fullName: u.fullName }))
	);
	if (result.status !== 'matched') return null;
	return existingUsers.find((u) => u.id === result.key) ?? null;
}

/**
 * Best-effort match of a raw "reports to" name against the other rows in the SAME
 * import batch. Handles spelling variants ("Deepak Gudur" vs "Deepak Guduru" vs
 * "Deepak") and word-order differences ("Santhosh Reddy S" vs "S Santhosh Reddy").
 *
 * A tie between two people resolves to no match rather than picking one: this is
 * a SUGGESTION the Super Admin confirms, and a blank is far easier to spot and
 * correct than a confident-looking wrong manager. The one exception is a tie
 * that only one of the tied people shares the row's team with — "Nagesh" for a
 * resort driver is the resort's C Nagesh, not Nagesha G in the data team.
 */
export function suggestReportsToIndex(
	reportingAuthorityRaw: string | null,
	rows: ParsedImportRow[],
	selfIndex: number
): number | null {
	const candidates = rows
		.map((row, i) => ({ key: String(i), fullName: row.fullName }))
		.filter((_, i) => i !== selfIndex);

	const result = matchName(reportingAuthorityRaw, candidates);
	if (result.status === 'matched') return Number(result.key);
	const team = rows[selfIndex]?.teamAndFloor?.trim().toLowerCase();
	if (result.status === 'ambiguous' && team) {
		const sameTeam = result.tied.filter((c) => rows[Number(c.key)].teamAndFloor?.trim().toLowerCase() === team);
		if (sameTeam.length === 1) return Number(sameTeam[0].key);
	}
	return null;
}
